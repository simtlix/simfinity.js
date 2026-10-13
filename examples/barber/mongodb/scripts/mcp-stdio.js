import { startStdioMCPServer } from '@simtlix/simfinity-js';
import { schema, mcpOptions, initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';
import { resolveMcpUserContext, verifyAccessToken } from '../auth/context.js';
import { renewSession, verifyRefreshToken } from '../types/auth/registerMutations.js';

// MCP_BEARER is a 15-minute access token. MCP_REFRESH_TOKEN (the refreshToken of the same login) lets
// this long-running process renew it in memory. With neither, the process is anonymous. Every tool call
// checks the current token and its account, so an expired, invalid or suspended identity fails the call
// with an error instead of running it as anonymous.
let accessToken = process.env.MCP_BEARER?.trim() || null;
let refreshToken = process.env.MCP_REFRESH_TOKEN?.trim() || null;
const signedIn = Boolean(accessToken || refreshToken);
let renewal = null;

function tokenProblem(token) {
  try {
    verifyAccessToken(token);
    return null;
  } catch (error) {
    return error.name === 'TokenExpiredError'
      ? `MCP_BEARER expired at ${error.expiredAt.toISOString()}`
      : `MCP_BEARER is not a valid access token for this server (${error.message})`;
  }
}

// Fails fast on credentials that could never work: a refresh token this server did not sign, or a pair
// from two accounts, which would switch identity at the first renewal.
function checkCredentials() {
  if (!refreshToken) return;
  let refreshSubject;
  try {
    refreshSubject = verifyRefreshToken(refreshToken).sub;
  } catch (error) {
    throw new Error(error.name === 'TokenExpiredError'
      ? `MCP_REFRESH_TOKEN expired at ${error.expiredAt.toISOString()}; sign in again`
      : `MCP_REFRESH_TOKEN is not a valid refresh token for this server (${error.message})`);
  }
  if (!accessToken) return;
  let bearerSubject;
  try {
    bearerSubject = verifyAccessToken(accessToken, { ignoreExpiration: true }).id;
  } catch (error) {
    throw new Error(`MCP_BEARER is not a valid access token for this server (${error.message})`);
  }
  if (bearerSubject !== refreshSubject) {
    throw new Error('MCP_BEARER and MCP_REFRESH_TOKEN belong to different accounts; use the tokens of one login');
  }
}

async function renew() {
  try {
    ({ accessToken, refreshToken } = await renewSession(refreshToken));
  } catch (error) {
    throw new Error(`MCP_REFRESH_TOKEN could not renew the session (${error.message}); sign in again and restart mcp:stdio`);
  }
}

async function stdioContext() {
  if (!signedIn) return { user: null };
  let problem = accessToken ? tokenProblem(accessToken) : 'no access token yet';
  if (problem && refreshToken) {
    // Concurrent calls share one renewal.
    renewal ??= renew().finally(() => { renewal = null; });
    await renewal;
    problem = tokenProblem(accessToken);
  }
  if (problem) {
    throw new Error(`${problem}; restart mcp:stdio with a fresh token or set MCP_REFRESH_TOKEN`);
  }
  return resolveMcpUserContext(`Bearer ${accessToken}`);
}

await initializeApplication();
try {
  checkCredentials();
  await stdioContext();
} catch (error) {
  console.error(`mcp:stdio: ${error.message}`);
  await closeDatabase();
  process.exit(1);
}
// The same tool catalog and auth plugin as HTTP /mcp: no login or token tools, since the process
// identity comes from MCP_BEARER and MCP_REFRESH_TOKEN.
const server = await startStdioMCPServer(schema, {
  ...mcpOptions,
  context: () => stdioContext(),
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    await closeDatabase();
    process.exit(0);
  });
}
