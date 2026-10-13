import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// A bearer token names its account here ("Bearer user-1"); upload.auth.test.js covers the real lookup.
vi.mock('../auth/context.js', () => ({
  resolveUserContext: async (header) => {
    const id = header?.slice('Bearer '.length);
    return { user: id?.startsWith('user-') ? { id, roles: ['CLIENT'] } : null };
  },
}));

const { createUploadRouter, serveUploads, detectImageType, sweepStagedUploads, STAGING_FOLDER, UPLOAD_TIMEOUT_MS, STAGING_SWEEP_MARGIN_MS } = await import('../routes/upload.js');
const { createRateLimiters } = await import('../routes/rateLimits.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const HTML = Buffer.from('<!doctype html><script>document.title=location.origin</script>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SCRIPT = Buffer.from('document.title = location.origin;');
const STYLE = Buffer.from('body { background: red }');
const BOUNDARY = 'barber-upload-test';

let root;
let staging;
const servers = [];

function listen(router) {
  const app = express();
  app.use('/api/uploads', serveUploads(root));
  app.use('/api/uploads', router);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, server });
    });
  });
}
function form(parts) {
  const fd = new FormData();
  for (const [name, value, filename, type] of parts) {
    if (filename === undefined) fd.append(name, value);
    else fd.append(name, new Blob([value], { type }), filename);
  }
  return fd;
}
async function post(base, fd, { query = '', user = 'user-1' } = {}) {
  const response = await fetch(`${base}/api/uploads${query}`, {
    method: 'POST', body: fd, headers: user ? { authorization: `Bearer ${user}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}
const listFiles = async (dir) => (await fs.readdir(dir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
  .sort();
const storedFiles = () => listFiles(root);
async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}
const stagedFiles = async () => (await fs.readdir(staging).catch(() => []));

// Starts a multipart upload by hand, sends `bytes` of its file part and stops there, as a stalled
// or still-uploading client would. The declared length stays under the request-size guard.
function startUpload(port, bytes) {
  const socket = net.connect(port, '127.0.0.1');
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="slow.png"\r\nContent-Type: image/png\r\n\r\n`);
  socket.write(`POST /api/uploads HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer user-slow\r\n`
    + `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${head.length + 5 * 1024 * 1024}\r\n\r\n`);
  socket.write(Buffer.concat([head, bytes]));
  let response = '';
  socket.on('data', (chunk) => { response += chunk; });
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  return { socket, response: () => response, closed };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'barber-uploads-'));
  staging = path.join(root, STAGING_FOLDER);
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const entry of await fs.readdir(root)) await fs.rm(path.join(root, entry), { recursive: true, force: true });
});

describe('detectImageType', () => {
  it('recognizes the allowed raster formats from their bytes', () => {
    expect(detectImageType(PNG)).toBe('image/png');
    expect(detectImageType(JPEG)).toBe('image/jpeg');
    expect(detectImageType(GIF)).toBe('image/gif');
    expect(detectImageType(WEBP)).toBe('image/webp');
  });
  it('rejects markup, scripts, SVG and truncated headers', () => {
    expect(detectImageType(HTML)).toBeNull();
    expect(detectImageType(SVG)).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(PNG.subarray(0, 4))).toBeNull();
  });
});

describe('POST /api/uploads', () => {
  let origin;
  beforeAll(async () => {
    ({ origin } = await listen(createUploadRouter({ root })));
  });

  it.each([
    ['image/png', PNG, '.png', 'image/gif'],
    ['image/jpeg', JPEG, '.jpg', 'image/png'],
    ['image/gif', GIF, '.gif', 'image/webp'],
    ['image/webp', WEBP, '.webp', 'image/jpeg'],
  ])('stores %s by its bytes, whatever the client declared and named it', async (type, bytes, ext, declared) => {
    const { status, body } = await post(origin, form([['file', bytes, 'photo.html', declared]]));
    expect(status).toBe(200);
    expect(body.filename).toMatch(new RegExp(`^[0-9a-f-]{36}\\${ext}$`));
    expect(body.url).toBe(`/api/uploads/${body.filename}`);
    expect(await fs.readFile(path.join(root, body.filename))).toEqual(bytes);
    expect(await storedFiles()).toEqual([body.filename]);
    const served = await fetch(`${origin}${body.url}`);
    expect(served.headers.get('content-type')).toBe(type);
    await served.arrayBuffer();
  });

  it('rejects HTML declared as an image and leaves nothing behind', async () => {
    const { status, body } = await post(origin, form([['file', HTML, 'x.png', 'image/png']]));
    expect(status).toBe(400);
    expect(body.error).toBe('Solo se permiten imagenes (jpeg, png, webp, gif)');
    expect(await storedFiles()).toEqual([]);
  });

  it('refuses SVG, declared as SVG or as another image type', async () => {
    expect((await post(origin, form([['file', SVG, 'x.svg', 'image/svg+xml']]))).status).toBe(400);
    expect((await post(origin, form([['file', SVG, 'x.png', 'image/png']]))).status).toBe(400);
    expect(await storedFiles()).toEqual([]);
  });

  it('accepts one file part and nothing else', async () => {
    const withField = await post(origin, form([['note', 'x'.repeat(1000)], ['file', PNG, 'p.png', 'image/png']]));
    expect(withField).toMatchObject({ status: 400, body: { error: 'Too many fields' } });
    const manyFields = new FormData();
    for (let i = 0; i < 5000; i += 1) manyFields.append(`f${i}`, 'v');
    expect((await post(origin, manyFields)).status).toBe(400);
    const twoFiles = await post(origin, form([['file', PNG, 'a.png', 'image/png'], ['file', PNG, 'b.png', 'image/png']]));
    expect(twoFiles.status).toBe(400);
    const fileAfterField = await post(origin, form([['file', PNG, 'a.png', 'image/png'], ['note', 'x']]));
    expect(fileAfterField.status).toBe(400);
    expect(await storedFiles()).toEqual([]);
  });

  it('answers 413 above 5 MB and removes the partial file', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const { status, body } = await post(origin, form([['file', big, 'big.png', 'image/png']]));
    expect(status).toBe(413);
    expect(body.error).toBe('Archivo demasiado grande (max 5MB)');
    expect(await storedFiles()).toEqual([]);
  });

  it('refuses a declared body above the limit before authenticating or reading it', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const { status, body } = await post(origin, form([['file', big, 'big.png', 'image/png']]), { user: null });
    expect(status).toBe(413);
    expect(body.error).toMatch(/max 5MB/);
  });

  it('validates the folder before reading the body', async () => {
    expect((await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { query: '?folder=a&folder=b' })).status).toBe(400);
    expect((await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { query: '?folder=../x' })).status).toBe(400);
    expect((await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { query: `?folder=${STAGING_FOLDER}` })).status).toBe(400);
    const nested = await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { query: '?folder=shops/logo' });
    expect(nested.status).toBe(200);
    expect(nested.body.url).toMatch(/^\/api\/uploads\/shops\/logo\/[0-9a-f-]{36}\.png$/);
    expect(await storedFiles()).toEqual([path.join('shops', 'logo', nested.body.filename)]);
  });

  it('still requires a bearer token of an account', async () => {
    expect((await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { user: null })).status).toBe(401);
    expect((await post(origin, form([['file', PNG, 'p.png', 'image/png']]), { user: 'deleted' })).status).toBe(401);
  });

  // The staging folder cannot be written (EACCES), or cannot be created (EEXIST: a file holds its name).
  it.each([
    ['is read-only', () => fs.mkdir(staging, { mode: 0o555 })],
    ['is a file', () => fs.writeFile(staging, '')],
  ])('answers 500 without server paths and logs the error when the staging folder %s', async (_case, breakStaging) => {
    await breakStaging();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { status, body } = await post(origin, form([['file', PNG, 'p.png', 'image/png']]));
      expect({ status, body }).toEqual({ status: 500, body: { error: 'No se pudo guardar el archivo' } });
      expect(logged).toHaveBeenCalledWith('Upload failed:', expect.objectContaining({ syscall: expect.any(String) }));
    } finally {
      logged.mockRestore();
      await fs.chmod(staging, 0o755);
    }
    expect(await stagedFiles()).toEqual([]);
    await fs.rm(staging, { force: true, recursive: true });
    expect(await storedFiles()).toEqual([]);
  });
});

describe('upload staging', () => {
  it('streams the file to an unserved staging folder and removes it when the client aborts', async () => {
    const { origin, port } = await listen(createUploadRouter({ root }));
    const upload = startUpload(port, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    // The bytes are on disk while the upload is in flight, not held in memory.
    const [staged] = await waitFor(async () => {
      for (const name of await stagedFiles()) {
        if ((await fs.stat(path.join(staging, name))).size >= 1024 * 1024) return [name];
      }
      return null;
    }, 'the staged file');
    expect(staged).toMatch(/^[0-9a-f-]{36}$/);
    expect((await fetch(`${origin}/api/uploads/${STAGING_FOLDER}/${staged}`)).status).toBe(404);
    upload.socket.destroy();
    await waitFor(async () => (await stagedFiles()).length === 0, 'the aborted upload to be removed');
    expect(await storedFiles()).toEqual([]);
  });

  it('settles once a shutdown closed the connection of an upload in flight and its file is removed', async () => {
    const router = createUploadRouter({ root });
    const { port, server } = await listen(router);
    startUpload(port, Buffer.concat([PNG, Buffer.alloc(64 * 1024)]));
    await waitFor(async () => (await stagedFiles()).length === 1, 'the staged file');
    // What index.yoga.js does once the shutdown grace period ends.
    server.closeAllConnections();
    await router.settled();
    expect(await stagedFiles()).toEqual([]);
  });

  it('removes, at startup, staged files that a crash or forced stop left behind', async () => {
    await fs.mkdir(staging);
    const stale = (Date.now() - UPLOAD_TIMEOUT_MS - STAGING_SWEEP_MARGIN_MS - 60_000) / 1000;
    for (const name of ['crashed', 'killed']) {
      await fs.writeFile(path.join(staging, name), PNG);
      await fs.utimes(path.join(staging, name), stale, stale);
    }
    // A file of an upload still in flight, here or on another server sharing the volume, is kept.
    await fs.writeFile(path.join(staging, 'in-flight'), PNG);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createUploadRouter({ root });
      await waitFor(async () => (await stagedFiles()).length === 1, 'the abandoned files to be removed');
      expect(await stagedFiles()).toEqual(['in-flight']);
      expect(logged).toHaveBeenCalledWith('Removed 2 abandoned staged upload(s)');
    } finally {
      logged.mockRestore();
    }
    expect(await sweepStagedUploads(root)).toEqual([]);
    expect(await sweepStagedUploads(root, { now: Date.now() + UPLOAD_TIMEOUT_MS + STAGING_SWEEP_MARGIN_MS + 1000 })).toEqual(['in-flight']);
    await fs.rm(staging, { recursive: true });
    expect(await sweepStagedUploads(root)).toEqual([]);
  });

  it('answers 408 to an upload that does not finish in time and removes its bytes', async () => {
    const { port } = await listen(createUploadRouter({ root, timeoutMs: 300 }));
    const upload = startUpload(port, PNG);
    await waitFor(async () => (await stagedFiles()).length === 1, 'the staged file');
    await upload.closed;
    expect(upload.response()).toMatch(/^HTTP\/1\.1 408 /);
    expect(upload.response()).toMatch(/Connection: close/i);
    expect(upload.response()).toContain('{"error":"La subida tardo demasiado"}');
    await waitFor(async () => (await stagedFiles()).length === 0, 'the timed-out upload to be removed');
    expect(await storedFiles()).toEqual([]);
  });
});

describe('upload limits', () => {
  it('limits each account after authentication and every IP loosely before it', async () => {
    const limiters = createRateLimiters({ UPLOAD_RATE_LIMIT_MAX: '2', UPLOAD_IP_RATE_LIMIT_MAX: '5' });
    const { origin } = await listen(createUploadRouter({ root, ipLimiter: limiters.uploadIp, userLimiter: limiters.upload }));
    const send = (user) => post(origin, form([['file', PNG, 'p.png', 'image/png']]), { user });
    const first = await send('user-1');
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-policy')).toBe('2;w=60');
    expect((await send('user-1')).status).toBe(200);
    const limited = await send('user-1');
    expect(limited).toMatchObject({ status: 429, body: { error: 'Demasiadas subidas, intenta de nuevo en un minuto' } });
    // Another account has its own budget; an anonymous request only counts against the IP.
    expect((await send('user-2')).status).toBe(200);
    expect((await send(null)).status).toBe(401);
    // Sixth request from this IP.
    const ipLimited = await send('user-3');
    expect(ipLimited).toMatchObject({ status: 429, body: { error: 'Demasiadas subidas, intenta de nuevo en un minuto' } });
    expect(ipLimited.headers.get('ratelimit-policy')).toBe('5;w=60');
    expect((await storedFiles()).length).toBe(3);
  });
});

describe('GET /api/uploads/*', () => {
  let origin;
  beforeAll(async () => {
    ({ origin } = await listen(createUploadRouter({ root })));
  });

  it('serves images as nosniff, sandboxed inline content', async () => {
    const { body } = await post(origin, form([['file', PNG, 'p.png', 'image/png']]));
    const response = await fetch(`${origin}${body.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('content-disposition')).toBeNull();
    await response.arrayBuffer();
  });

  it('serves files stored by earlier versions as sandboxed attachments that no page can run or apply', async () => {
    const legacy = { 'legacy.html': HTML, 'legacy.svg': SVG, 'legacy.js': SCRIPT, 'legacy.css': STYLE, 'legacy.MJS': SCRIPT };
    for (const [name, bytes] of Object.entries(legacy)) await fs.writeFile(path.join(root, name), bytes);
    for (const name of Object.keys(legacy)) {
      const response = await fetch(`${origin}/api/uploads/${name}`);
      expect(response.status).toBe(200);
      // With nosniff, a browser refuses to run these types through <script src> or apply them through
      // <link>. SVG keeps its image type so <img> still shows logos stored by earlier versions.
      expect(response.headers.get('content-type')).toBe(name.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
      expect(response.headers.get('content-disposition')).toBe('attachment');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      await response.arrayBuffer();
    }
  });

  it('never serves dot files', async () => {
    await fs.writeFile(path.join(root, '.gitkeep'), '');
    expect((await fetch(`${origin}/api/uploads/.gitkeep`)).status).toBe(404);
  });
});
