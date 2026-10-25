import { createHash } from 'node:crypto';
import { buildClientDescriptor } from './client-descriptor.js';
import SimfinityError from '@simtlix/simfinity-core/internal/errors';

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const invalid = () => new SimfinityError('Invalid client descriptor handler options: provide authorize: public or a function, and optional context/onError', 'INVALID_CLIENT_DESCRIPTOR_OPTIONS', 500);
const KEYS = new Set(['authorize', 'context', 'onError']);
const readOptions = (options) => {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some((key) => !KEYS.has(key))
    || !Object.hasOwn(options, 'authorize')
    || (options.authorize !== 'public' && typeof options.authorize !== 'function')
    || (options.onError !== undefined && typeof options.onError !== 'function')) throw invalid();
  return { authorize: options.authorize, context: options.context, onError: options.onError };
};
// Validate the whole list, including quoted commas; an arbitrary substring is not a cache match.
const matches = (header, etag) => {
  if (typeof header !== 'string') return false;
  const value = header.trim();
  if (value === '*') return true;
  if (!/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"(?:\s*,\s*(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")*$/.test(value)) return false;
  return [...value.matchAll(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g)].some(([tag]) => tag.replace(/^W\//, '') === etag);
};
const envelope = (message, code) => JSON.stringify({ errors: [{ message, extensions: { code } }] });

/** A separately mounted, immutable descriptor. Authorization runs on HEAD and cache hits too. */
export const createClientDescriptorHandler = (schema, options) => {
  const { authorize, context, onError } = readOptions(options);
  const body = JSON.stringify(canonical(buildClientDescriptor(schema)));
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const gated = authorize !== 'public';
  return async (req, res) => {
    const send = (status, content) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(req.method === 'HEAD' ? undefined : content);
    };
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Cache-Control', 'no-store');
        send(405, envelope('Method not allowed', 'METHOD_NOT_ALLOWED'));
        return;
      }
      const ctx = typeof context === 'function' ? await context(req) : context;
      if (gated) {
        const allowed = await authorize(req, ctx);
        if (allowed !== true && allowed !== undefined) throw new SimfinityError('Access denied', 'FORBIDDEN', 403);
      }
      res.setHeader('Cache-Control', gated ? 'private, no-cache' : 'no-cache');
      if (gated) res.setHeader('Vary', 'Authorization, Cookie');
      res.setHeader('ETag', etag);
      if (matches(req.headers['if-none-match'], etag)) {
        res.statusCode = 304;
        res.end();
      } else send(200, body);
    } catch (error) {
      const known = error instanceof SimfinityError && [401, 403].includes(error.getStatus());
      try { if (!known && onError) await onError(error, req, res); } catch { /* Reporting cannot replace the HTTP result. */ }
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.removeHeader('ETag');
      res.setHeader('Cache-Control', 'no-store');
      send(known ? error.getStatus() : 500,
        envelope(known ? error.message : 'Internal server error', known ? error.getCode() : 'INTERNAL_SERVER_ERROR'));
    }
  };
};
