import express, { Router } from 'express';
import multer from 'multer';
import { resolveUserContext } from '../auth/context.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');
// Uploads are written here, under a name without extension, until their bytes are checked. The folder
// is on the same volume as the stored files, so moving one is a rename, and serveUploads never serves
// a dot folder.
export const STAGING_FOLDER = '.incoming';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Multipart framing around one file part; a larger declared body is refused before it is read.
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
// One file part named "file" and nothing else: no text fields, no extra parts.
export const UPLOAD_LIMITS = Object.freeze({
  fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 100, headerPairs: 20,
});
// The body must arrive within this time; a stalled or very slow upload gets 408 and is removed.
export const UPLOAD_TIMEOUT_MS = 60 * 1000;
// A staged file older than the upload timeout plus this margin belongs to no running upload: a crash or
// a forced stop left it behind. The margin covers other servers that share the uploads volume.
export const STAGING_SWEEP_MARGIN_MS = 60 * 1000;

// Raster images only. SVG is refused, even though stored files are served inert (see serveUploads):
// it can carry scripts, and the frontend asks for these four types only.
// The stored extension comes from the type detected in the bytes, never from the client's name or type.
export const IMAGE_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
});
const INLINE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const NOT_AN_IMAGE = 'Solo se permiten imagenes (jpeg, png, webp, gif)';
const TOO_LARGE = 'Archivo demasiado grande (max 5MB)';
const TOO_SLOW = 'La subida tardo demasiado';
const SNIFF_BYTES = 12;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detects the image type from a file's leading bytes; null when it is not an allowed image. */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('latin1', 0, 6))) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readHead(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// --- Folder path sanitization ---

function sanitizeFolderPath(raw, root) {
  if (raw === undefined || raw === '') return '';
  // A repeated ?folder arrives as an array.
  if (typeof raw !== 'string') throw new Error('Invalid folder path');
  const segments = raw.split('/').filter(Boolean);
  if (segments.length > 5) throw new Error('Folder path too deep (max 5 levels)');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error('Invalid folder path segment');
    if (seg.length > 64) throw new Error('Folder segment too long (max 64 chars)');
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) throw new Error('Folder segment contains invalid characters');
  }
  const resolved = path.resolve(root, ...segments);
  if (!resolved.startsWith(root)) throw new Error('Invalid folder path');
  return segments.join('/');
}

// --- Request guards ---

// Answers before authentication or parsing; chunked bodies are still bounded by UPLOAD_LIMITS.
function rejectOversizedRequest(req, res, next) {
  if (Number(req.headers['content-length']) > MAX_UPLOAD_REQUEST_BYTES) {
    return res.status(413).json({ error: TOO_LARGE });
  }
  return next();
}

// --- Auth middleware (the same request context as GraphQL) ---

/** A token of a deleted or suspended account is rejected like an invalid one. */
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  let user;
  try {
    ({ user } = await resolveUserContext(authHeader));
  } catch (error) {
    // The account could not be read; answer JSON like the rest of this router, not Express's HTML page.
    console.error('Upload authentication failed:', error);
    return res.status(503).json({ error: 'No se pudo verificar la sesion' });
  }
  if (!user) {
    return res.status(401).json({ error: 'Token invalido' });
  }
  req.user = user;
  return next();
}

// --- Multer config ---

// A cheap first check of the declared type; the bytes decide what is stored.
const fileFilter = (_req, file, cb) => {
  if (Object.hasOwn(IMAGE_EXTENSIONS, file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(NOT_AN_IMAGE), false);
  }
};

// --- Serving ---

/**
 * Serves stored uploads. Every response is nosniff and sandboxed. Anything that is not a raster image
 * (such as a file an earlier version stored under the client's extension, e.g. `.js` or `.css`) is an
 * `application/octet-stream` attachment: with nosniff, browsers neither run it as a script nor apply
 * it as a stylesheet when another page includes it. SVG images that earlier versions accepted keep
 * `image/svg+xml`, so pages still show them through <img>, which runs no script; as an attachment
 * with nosniff they cannot run as a page, a script or a stylesheet either. Dot files and folders,
 * including the staging folder, are never served.
 */
export function serveUploads(root = UPLOADS_ROOT) {
  return express.static(root, {
    dotfiles: 'ignore',
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const extension = path.extname(filePath).toLowerCase();
      if (!INLINE_EXTENSIONS.has(extension)) {
        // Set before express.static picks a type from the extension, which it then leaves alone.
        res.setHeader('Content-Type', extension === '.svg' ? 'image/svg+xml' : 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  });
}

// --- Router ---

/**
 * Turns multer's outcome into the reply. A staged file is moved to `<folder>/<uuid><ext of the
 * detected type>` or removed before the reply is sent, so a rejected upload leaves nothing behind.
 * (Multer removes the file itself when it fails.) Throws when the server could not store the file.
 */
async function settleUpload(err, file, { root, folder, timedOut }) {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return { status: 413, body: { error: TOO_LARGE } };
    // A Node system error (EACCES, EMFILE, ENOSPC while creating or writing the staged file) is the
    // server's fault, and its message names server paths: the caller logs it and answers 500.
    if (err.syscall !== undefined || err.errno !== undefined) throw err;
    // Multer's limits, the declared-type check and malformed multipart bodies describe the request.
    return { status: 400, body: { error: err.message } };
  }
  if (!file) return { status: 400, body: { error: 'No se envio ningun archivo' } };
  let stored = false;
  try {
    if (timedOut) return null;
    const type = detectImageType(await readHead(file.path));
    if (!type) return { status: 400, body: { error: NOT_AN_IMAGE } };
    const dest = folder ? path.join(root, folder) : root;
    await fs.mkdir(dest, { recursive: true });
    const filename = `${path.basename(file.path)}${IMAGE_EXTENSIONS[type]}`;
    await fs.rename(file.path, path.join(dest, filename));
    stored = true;
    return { status: 200, body: { filename, url: folder ? `/api/uploads/${folder}/${filename}` : `/api/uploads/${filename}` } };
  } finally {
    if (!stored) {
      await fs.rm(file.path, { force: true }).catch((error) => console.error('Could not remove a staged upload:', error));
    }
  }
}

/**
 * Removes staged files that no running upload owns: those a crash or a forced stop left in the staging
 * folder, which the request lifecycle never got to remove. Returns the names it removed.
 */
export async function sweepStagedUploads(root = UPLOADS_ROOT, { maxAgeMs = UPLOAD_TIMEOUT_MS + STAGING_SWEEP_MARGIN_MS, now = Date.now() } = {}) {
  const staging = path.join(root, STAGING_FOLDER);
  const entries = await fs.readdir(staging).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const removed = [];
  for (const name of entries) {
    const entry = path.join(staging, name);
    const stats = await fs.lstat(entry).catch(() => null);
    if (!stats || now - stats.mtimeMs <= maxAgeMs) continue;
    await fs.rm(entry, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * POST / stores one image: `ipLimiter` and the declared size are checked before authentication,
 * `userLimiter` (keyed by req.user) after it. The file streams to the staging folder, so no upload is
 * held in memory, and is moved to `<folder>/<uuid><ext of the detected type>` once its bytes are
 * checked; a rejected, failed, aborted or timed-out upload leaves nothing behind. Files that a crash
 * or a forced stop left in the staging folder are removed when the router is created, at startup.
 * `router.settled()` resolves once every upload in flight has replied or been removed; a shutdown
 * awaits it after closing the connections, so an aborted upload's file is gone before the process exits.
 */
export function createUploadRouter({
  root = UPLOADS_ROOT, ipLimiter, userLimiter, timeoutMs = UPLOAD_TIMEOUT_MS,
} = {}) {
  const staging = path.join(root, STAGING_FOLDER);
  sweepStagedUploads(root, { maxAgeMs: timeoutMs + STAGING_SWEEP_MARGIN_MS })
    .then((removed) => { if (removed.length) console.log(`Removed ${removed.length} abandoned staged upload(s)`); })
    .catch((error) => console.error('Could not sweep the upload staging folder:', error));
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdir(staging, { recursive: true }).then(() => cb(null, staging), cb);
      },
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    fileFilter,
    limits: UPLOAD_LIMITS,
  });
  const optional = (middleware) => (middleware ? [middleware] : []);
  const router = Router();
  const inFlight = new Set();
  router.settled = () => Promise.all(inFlight);

  router.post('/', ...optional(ipLimiter), rejectOversizedRequest, requireAuth, ...optional(userLimiter), (req, res) => {
    let folder;
    try {
      folder = sanitizeFolderPath(req.query.folder, root);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const deadline = setTimeout(() => {
      if (res.headersSent || res.destroyed) return;
      // Node closes the connection after this response but does not end a request whose response
      // finished first, so end it then: multer stops reading and removes the partial file.
      req.socket?.once('close', () => req.destroy());
      res.status(408).set('Connection', 'close').json({ error: TOO_SLOW });
    }, timeoutMs);

    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    inFlight.add(done);
    return upload.single('file')(req, res, async (err) => {
      clearTimeout(deadline);
      let reply;
      try {
        reply = await settleUpload(err, req.file, { root, folder, timedOut: res.headersSent });
      } catch (error) {
        // The file could not be read or moved; answer JSON like the rest of this router.
        console.error('Upload failed:', error);
        reply = { status: 500, body: { error: 'No se pudo guardar el archivo' } };
      } finally {
        inFlight.delete(done);
        finish();
      }
      // A timed-out upload already has its 408.
      return res.headersSent ? undefined : res.status(reply.status).json(reply.body);
    });
  });

  return router;
}
