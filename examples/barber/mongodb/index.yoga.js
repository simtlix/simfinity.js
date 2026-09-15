import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createYoga } from 'graphql-yoga';
import * as simfinity from '@simtlix/simfinity-js';
import { useErrorHandler } from '@envelop/core';
import { schema, authPlugin, initializeApplication } from './application.js';
import { closeDatabase } from './database.js';
import { buildUserContext } from './auth/context.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import uploadRouter from './routes/upload.js';

await initializeApplication();

const useCountPlugin = simfinity.plugins.envelopCountPlugin;

const app = express();
app.use(cors());

const graphqlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.GRAPHQL_RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
});

const yoga = createYoga({
  schema,
  context: ({ request }) => buildUserContext(request.headers.get('authorization')),
  plugins: [
    useErrorHandler(simfinity.buildErrorFormatter(console.error)),
    useCountPlugin(),
    authPlugin,
  ],
  graphiql: true,
  graphqlEndpoint: '/graphql',
  maskedErrors: false,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', uploadRouter);

app.use('/graphql', graphqlLimiter, yoga);

// MCP endpoint (Streamable HTTP) exposing the same GraphQL operations as tools.
// The context factory receives the Express `req`, so the JWT is read per request
// just like the GraphQL endpoint.
const mcpHandler = await simfinity.createHTTPMCPHandler(schema, {
  serverName: 'simfinity-barber-mcp',
  serverVersion: '1.0.0',
  // Scalar results avoid automatically selecting related private user profiles.
  selectionDepth: 0,
  context: (req) => buildUserContext(req.headers.authorization),
  // Apply the SAME auth plugin instance as Yoga so MCP tool calls enforce the
  // permission rules. createAuthPlugin wraps the schema's resolvers from its
  // onSchemaChange hook (which Envelop fires for Yoga); schemaPlugins fires it
  // for the in-process MCP execution path too. Sharing the instance means the
  // shared schema is wrapped exactly once (the plugin guards with a WeakSet).
  schemaPlugins: [authPlugin],
});
app.post('/mcp', express.json(), mcpHandler);

const PORT = process.env.PORT || 4400;
const server = app.listen(PORT, () => {
  console.log(`GraphQL endpoint: http://localhost:${PORT}/graphql`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

app.get('/health', (_req, res) => res.json({ status: 'ok', database: 'mongodb' }));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => {
    await closeDatabase();
    process.exit(0);
  }));
}
