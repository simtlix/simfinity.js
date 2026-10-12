/**
 * JSON answers for errors that reach Express. Without them, Express's default handler answers with an
 * HTML page and, unless NODE_ENV is production, a stack trace with server paths.
 */

const jsonRpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Mount right after express.json() on /mcp. A body that is not JSON gets the JSON-RPC Parse error, one
 * above the parser's size limit gets 413, and other body-parser rejections keep their status and
 * exposed message. Anything else goes on to the next error handler.
 */
export function mcpBodyErrors(err, _req, res, next) {
  if (err?.type === 'entity.parse.failed') return jsonRpcError(res, 400, -32700, 'Parse error: the request body is not valid JSON');
  if (err?.type === 'entity.too.large') return jsonRpcError(res, 413, -32000, 'Request body too large');
  if (typeof err?.type === 'string' && err.expose && err.status >= 400 && err.status < 500) return jsonRpcError(res, err.status, -32000, err.message);
  return next(err);
}

/**
 * The app's last middleware. A client error keeps its status and, when it is meant for the client,
 * its message; anything else is logged and answers 500. No stack traces or server paths are sent.
 */
export function jsonErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ error: err.expose ? err.message : 'Bad request' });
  }
  console.error('Request failed:', err);
  return res.status(500).json({ error: 'Internal server error' });
}
