// Craft web harness: serves the launcher, the standalone app bundles in apps/<id>/,
// and a small file API that stores each app's saved files under data/<id>/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPS_DIR = path.join(ROOT, 'apps');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8480);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const USER = process.env.HARNESS_USER || '';
const PASS = process.env.HARNESS_PASS || '';

const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps.json'), 'utf8'));
const byId = new Map(registry.map((a) => [a.id, a]));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';

function authorized(req) {
  if (!USER && !PASS) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  const ok = (a, b) => {
    const x = crypto.createHash('sha256').update(a).digest();
    const y = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(x, y);
  };
  return ok(u, USER) & ok(rest.join(':'), PASS);
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

// ---- file API ----------------------------------------------------------
function safeName(raw) {
  let n = decodeURIComponent(raw);
  if (!n || n.length > 200 || /[\/\\\0]/.test(n) || n.startsWith('.') || n.endsWith('.part')) return null;
  return n;
}
function appDataDir(id) {
  const dir = path.join(DATA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listFiles(id) {
  const dir = appDataDir(id);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
    .map((d) => { const s = fs.statSync(path.join(dir, d.name)); return { name: d.name, size: s.size, modified: s.mtimeMs }; })
    .sort((a, b) => b.modified - a.modified);
}

async function handleApi(req, res, parts) {
  // /api/apps | /api/files/<app> | /api/files/<app>/<name>
  if (parts[1] === 'apps' && req.method === 'GET') {
    return json(res, 200, registry.map((a) => ({
      ...a,
      installed: fs.existsSync(path.join(APPS_DIR, a.id, 'index.html')),
      version: readVersion(a.id),
      files: fs.existsSync(path.join(DATA_DIR, a.id)) ? listFiles(a.id).length : 0,
    })));
  }
  if (parts[1] !== 'files' || !byId.has(parts[2])) return json(res, 404, { error: 'not found' });
  const id = parts[2];
  if (parts.length === 3 && req.method === 'GET') return json(res, 200, listFiles(id));
  const name = parts[3] && safeName(parts[3]);
  if (!name || parts.length !== 4) return json(res, 400, { error: 'bad file name' });
  const file = path.join(appDataDir(id), name);

  if (req.method === 'GET') {
    let st;
    try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'no such file' }); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'PUT') {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: 'too large' });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD && !failed) { failed = true; req.destroy(); out.destroy(); fs.rm(tmp, { force: true }, () => {}); }
    });
    req.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, file); json(res, 200, { name, size }); });
    const bail = () => { fs.rm(tmp, { force: true }, () => {}); if (!res.writableEnded) json(res, 500, { error: 'upload failed' }); };
    out.on('error', bail); req.on('error', bail);
    return;
  }
  if (req.method === 'DELETE') {
    try { fs.unlinkSync(file); } catch { return json(res, 404, { error: 'no such file' }); }
    return json(res, 200, { deleted: name });
  }
  return json(res, 405, { error: 'method not allowed' });
}

// ---- static serving ----------------------------------------------------
function readVersion(id) {
  try { return fs.readFileSync(path.join(APPS_DIR, id, 'UPSTREAM_VERSION'), 'utf8').trim(); } catch { return null; }
}
const indexCache = new Map(); // file -> {mtimeMs, html}
function injectedIndex(file, id) {
  const st = fs.statSync(file);
  const hit = indexCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.html;
  const tag = `<script src="/_harness/shim.js" data-app="${id}"></script>`;
  let html = fs.readFileSync(file, 'utf8');
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
  indexCache.set(file, { mtimeMs: st.mtimeMs, html });
  return html;
}

function serveFile(req, res, file, { immutable = false } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': typeOf(file), ETag: etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  const ae = req.headers['accept-encoding'] || '';
  let src = file, enc = null;
  if (/\bbr\b/.test(ae) && fs.existsSync(file + '.br')) { src = file + '.br'; enc = 'br'; }
  else if (/\bgzip\b/.test(ae) && fs.existsSync(file + '.gz')) { src = file + '.gz'; enc = 'gzip'; }
  if (enc) headers['Content-Encoding'] = enc;
  headers['Content-Length'] = fs.statSync(src).size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(src).pipe(res);
  return true;
}

function serveHtml(req, res, html) {
  const buf = Buffer.from(html);
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    return send(res, 200, zlib.gzipSync(buf), headers);
  }
  send(res, 200, buf, headers);
}

const HASHED = /[-_.][0-9a-f]{12,}[-_.]/;

function under(base, rel) {
  const p = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return p === base || p.startsWith(base + path.sep) ? p : null;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Craft web harness", charset="UTF-8"' });
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    const parts = pathname.split('/').filter(Boolean);

    if (pathname === '/healthz') return json(res, 200, { ok: true });
    if (parts[0] === 'api') return await handleApi(req, res, parts);
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'method not allowed' });

    if (parts[0] === '_harness') {
      const f = under(PUBLIC_DIR, parts.slice(1).join('/'));
      if (f && serveFile(req, res, f)) return;
      return send(res, 404, 'Not found');
    }
    if (parts[0] === 'apps' && byId.has(parts[1])) {
      const id = parts[1];
      if (parts.length === 2 && !pathname.endsWith('/')) return send(res, 301, '', { Location: `/apps/${id}/${url.search}` });
      const base = path.join(APPS_DIR, id);
      const rel = parts.slice(2).join('/');
      const f = under(base, rel || 'index.html');
      if (!f) return send(res, 400, 'Bad path');
      const isIndex = f === path.join(base, 'index.html');
      if (isIndex && fs.existsSync(f)) return serveHtml(req, res, injectedIndex(f, id));
      if (serveFile(req, res, f, { immutable: HASHED.test(path.basename(f)) })) return;
      return send(res, 404, 'Not found');
    }
    const f = under(PUBLIC_DIR, pathname === '/' ? 'launcher.html' : parts.join('/'));
    if (f && serveFile(req, res, f)) return;
    send(res, 404, 'Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Craft web harness on http://${HOST}:${PORT}  (data: ${DATA_DIR})`);
  if (!USER && !PASS) console.warn('WARNING: HARNESS_USER/HARNESS_PASS not set; anyone who can reach this port can read and write saved files.');
});
