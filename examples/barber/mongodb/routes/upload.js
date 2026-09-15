import { Router } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

const ALLOWED_MIMETYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

// --- Folder path sanitization ---

function sanitizeFolderPath(raw) {
  if (!raw) return '';
  const segments = raw.split('/').filter(Boolean);
  if (segments.length > 5) throw new Error('Folder path too deep (max 5 levels)');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') throw new Error('Invalid folder path segment');
    if (seg.length > 64) throw new Error('Folder segment too long (max 64 chars)');
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) throw new Error('Folder segment contains invalid characters');
  }
  const resolved = path.resolve(UPLOADS_ROOT, ...segments);
  if (!resolved.startsWith(UPLOADS_ROOT)) throw new Error('Invalid folder path');
  return segments.join('/');
}

// --- Auth middleware (same logic as index.yoga.js) ---

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    const roles = Array.isArray(payload.roles) ? payload.roles : ['CLIENT'];
    req.user = { id: payload.sub, email: payload.email, roles, role: roles[0] };
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalido' });
  }
}

// --- Multer config ---

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      const folder = sanitizeFolderPath(req.query.folder);
      const dest = folder ? path.join(UPLOADS_ROOT, folder) : UPLOADS_ROOT;
      await fs.mkdir(dest, { recursive: true });
      req._uploadFolder = folder;
      cb(null, dest);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIMETYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten imagenes (jpeg, png, webp, gif, svg)'), false);
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// --- Router ---

const router = Router();

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Archivo demasiado grande (max 5MB)' });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se envio ningun archivo' });
    }

    const folder = req._uploadFolder || '';
    const urlPath = folder
      ? `/api/uploads/${folder}/${req.file.filename}`
      : `/api/uploads/${req.file.filename}`;

    res.json({ filename: req.file.filename, url: urlPath });
  });
});

export default router;
