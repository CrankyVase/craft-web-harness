// Pulls each app's standalone web repo into apps/<id>/ (clone the first time, fast-forward after)
// and precompresses new files with brotli so the server can send them as-is.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps.json'), 'utf8'));
const only = process.argv.slice(2);
const COMPRESS = new Set(['.wasm', '.js', '.mjs', '.css', '.json', '.svg', '.ttf', '.otf', '.webmanifest', '.txt']);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

function compress(dir) {
  let n = 0;
  for (const f of walk(dir)) {
    if (/\.(br|gz)$/.test(f) || !COMPRESS.has(path.extname(f).toLowerCase())) continue;
    const src = fs.statSync(f);
    if (src.size < 1024) continue;
    const out = f + '.br';
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src.mtimeMs) continue;
    const buf = zlib.brotliCompressSync(fs.readFileSync(f), { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.size } });
    if (buf.length < src.size) { fs.writeFileSync(out, buf); n++; }
  }
  return n;
}

fs.mkdirSync(path.join(ROOT, 'apps'), { recursive: true });
let failed = 0;
for (const app of registry) {
  if (only.length && !only.includes(app.id)) continue;
  const dir = path.join(ROOT, 'apps', app.id);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      console.log(`[${app.id}] cloning ${app.webRepo}`);
      execFileSync('git', ['clone', '--depth', '1', `https://github.com/${app.webRepo}.git`, dir], { stdio: 'inherit' });
    } else {
      const before = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'fetch', '--depth', '1', 'origin');
      git(dir, 'reset', '--hard', '@{upstream}');
      console.log(`[${app.id}] ${before === git(dir, 'rev-parse', 'HEAD') ? 'up to date' : 'updated'}`);
    }
    const n = compress(dir);
    const v = fs.existsSync(path.join(dir, 'UPSTREAM_VERSION')) ? fs.readFileSync(path.join(dir, 'UPSTREAM_VERSION'), 'utf8').trim() : '?';
    console.log(`[${app.id}] ${v}${n ? `, compressed ${n} files` : ''}`);
  } catch (e) {
    failed++;
    console.error(`[${app.id}] failed: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
