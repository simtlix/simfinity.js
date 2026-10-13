import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createYoga } from 'graphql-yoga';
import * as simfinity from '@simtlix/simfinity-js';
import { useErrorHandler } from '@envelop/core';
import { schema, authPlugin, mcpOptions, initializeApplication } from './application.js';
import { closeDatabase } from './database.js';
import { resolveMcpUserContext, resolveUserContext } from './auth/context.js';
import { useSingleAuthOperation } from './auth/authOperations.js';
import { createUploadRouter, serveUploads } from './routes/upload.js';
import { createRateLimiters, rejectJsonRpcBatch } from './routes/rateLimits.js';
import { jsonErrorHandler, mcpBodyErrors } from './routes/errors.js';

// GraphQL, MCP and uploads each have their own budget (see routes/rateLimits.js). Created before
// connecting, so an invalid limit in the environment stops the server at once.
const limiters = createRateLimiters();

await initializeApplication();

const useCountPlugin = simfinity.plugins.envelopCountPlugin;
// Classifies each GraphQL error and logs it; responses are not changed.
const logError = simfinity.buildErrorFormatter(console.error);

const app = express();
app.use(cors());

const yoga = createYoga({
  schema,
  // Reads the caller's account: a deleted or suspended account's token is anonymous here.
  context: ({ request }) => resolveUserContext(request.headers.get('authorization')),
  plugins: [
    // useErrorHandler passes { errors, context, phase }, not an error, so format each error.
    useErrorHandler(({ errors }) => { errors.forEach((error) => logError(error)); }),
    useCountPlugin(),
    authPlugin,
    // One login, register, registerOwner or refreshSession per request, whatever the aliases.
    useSingleAuthOperation(),
  ],
  graphiql: true,
  graphqlEndpoint: '/graphql',
  maskedErrors: false,
});

// Stored files are served inert (nosniff, sandbox CSP). POST stores one image, checked by its bytes,
// with a loose per-IP limit before authentication and a per-account limit after it.
app.use('/api/uploads', serveUploads());
const uploads = createUploadRouter({ ipLimiter: limiters.uploadIp, userLimiter: limiters.upload });
app.use('/api/uploads', uploads);

app.use('/graphql', limiters.graphql, yoga);

// MCP endpoint (Streamable HTTP) exposing the GraphQL operations as tools, except login, register,
// registerOwner and refreshSession, which stay GraphQL-only (see mcpOptions in application.js).
// Callers send the access token of a GraphQL login as `Authorization: Bearer`. The context factory
// receives the Express `req`, so the token is read per request, as on the GraphQL endpoint.
const mcpHandler = await simfinity.createHTTPMCPHandler(schema, {
  ...mcpOptions,
  // Unlike GraphQL, a deleted or suspended account's token fails the tool call with an error.
  context: (req) => resolveMcpUserContext(req.headers.authorization),
});
// Mount on every method: the handler serves POST and answers other methods with 405 and `Allow: POST`,
// which MCP clients expect when they try to open a GET event stream.
// The limiter runs before the body is parsed, and a JSON-RPC batch is refused, so one request is one call.
// A body that is not JSON, or is too large, gets a JSON-RPC error instead of Express's HTML error page.
app.all('/mcp', limiters.mcp, express.json(), mcpBodyErrors, rejectJsonRpcBatch, mcpHandler);

const PORT = process.env.PORT || 4400;
const server = app.listen(PORT, () => {
  console.log(`GraphQL endpoint: http://localhost:${PORT}/graphql`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

app.get('/health', (_req, res) => res.json({ status: 'ok', database: 'mongodb' }));
// Errors that reach Express answer JSON, without stack traces or server paths.
app.use(jsonErrorHandler);

// On shutdown, requests in flight get a short grace period; then their connections are closed, so a
// stalled upload is aborted and its staged file removed before a container stop's 10 s timeout ends in
// SIGKILL. Files that a kill leaves behind are swept at the next start (see createUploadRouter).
const SHUTDOWN_GRACE_MS = 5000;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(async () => {
      // The connections are closed, but an aborted upload may still be removing its staged file.
      await uploads.settled();
      await closeDatabase();
      process.exit(0);
    });
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  });
}
