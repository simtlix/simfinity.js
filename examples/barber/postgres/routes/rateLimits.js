import rateLimit from 'express-rate-limit';

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Requests per minute, overridable through the environment. Every limiter has its own counter.
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  // Per client IP.
  GRAPHQL_RATE_LIMIT_MAX: 300,
  // Per client IP.
  MCP_RATE_LIMIT_MAX: 300,
  // Per client IP, checked before authentication. Loose, because users behind one proxy or Docker's
  // port forwarding share an IP; it bounds anonymous and oversized requests.
  UPLOAD_IP_RATE_LIMIT_MAX: 100,
  // Per account, checked after authentication.
  UPLOAD_RATE_LIMIT_MAX: 20,
});

/** Reads a limit from the environment; anything but a positive integer stops the server at startup. */
export function readRateLimit(name, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return RATE_LIMIT_DEFAULTS[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const MCP_LIMITED = { jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests, please try again later.' }, id: null };
const UPLOAD_LIMITED = { error: 'Demasiadas subidas, intenta de nuevo en un minuto' };

/**
 * One limiter per route, so MCP and upload traffic do not use up the GraphQL budget. /health and
 * GET /api/uploads/* stay unlimited: health checks poll them, and pages may show many images.
 * Create the limiters once, at startup.
 */
export function createRateLimiters(env = process.env) {
  const limiter = (name, options = {}) => rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: readRateLimit(name, env),
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
  return {
    // GraphQL keeps express-rate-limit's default 429 text body.
    graphql: limiter('GRAPHQL_RATE_LIMIT_MAX'),
    mcp: limiter('MCP_RATE_LIMIT_MAX', { message: MCP_LIMITED }),
    uploadIp: limiter('UPLOAD_IP_RATE_LIMIT_MAX', { message: UPLOAD_LIMITED }),
    // Runs after requireAuth, which sets req.user.
    upload: limiter('UPLOAD_RATE_LIMIT_MAX', { message: UPLOAD_LIMITED, keyGenerator: (req) => `user:${req.user.id}` }),
  };
}

/**
 * A JSON-RPC batch runs every message of one HTTP request, which a per-request limiter cannot
 * bound. MCP 2025-06-18 removed batching, so answer an array with a JSON-RPC Invalid Request.
 */
export function rejectJsonRpcBatch(req, res, next) {
  if (!Array.isArray(req.body)) return next();
  return res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Invalid Request: JSON-RPC batches are not supported' },
    id: null,
  });
}
