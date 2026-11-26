// Slate on your own computer — no Cloudflare, no account, nothing online (2026-11-26).
//
//   node local.mjs            → builds the board from scripts/*.md and opens http://localhost:4321
//   node local.mjs --port 5000 --no-open
//
// The same board as the Cloudflare version (the real src/worker.js runs here); stages, dates and notes are kept in
// .slate-local.json next to this file. Add or edit a card (.md in scripts/), then restart local.mjs (or say "刷新看板").
// It opens the board already signed in (the pass-code link); the code itself is in key.txt (made on first run). Your AI can write cards with the API in API.md: base URL http://localhost:4321,
// token = ADMIN_TOKEN in .slate-secrets.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = +(args[args.indexOf('--port') + 1] || 0) || 4321;
execFileSync(process.execPath, [path.join(ROOT, 'deploy.mjs'), '--dry', 'build'], { stdio: ['ignore', 'ignore', 'inherit'] });
const { default: worker, Board } = await import(pathToFileURL(path.join(ROOT, 'build', 'worker.js')).href + '?t=' + Date.now());
const S = JSON.parse(fs.readFileSync(path.join(ROOT, '.slate-secrets.json'), 'utf8'));
const KEY = fs.readFileSync(path.join(ROOT, 'key.txt'), 'utf8').trim();

// Durable Object storage → one JSON file
const FILE = path.join(ROOT, '.slate-local.json');
const db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
let timer = null;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(db)), 150); };
const storage = (ns) => {
  const k = (x) => ns + '\u0000' + x;
  return {
    get: async (x) => (Array.isArray(x) ? new Map(x.filter((y) => k(y) in db).map((y) => [y, structuredClone(db[k(y)])])) : structuredClone(db[k(x)])),
    put: async (x, v) => { if (typeof x === 'object') { for (const [a, b] of Object.entries(x)) db[k(a)] = structuredClone(b); } else db[k(x)] = structuredClone(v); save(); },
    delete: async (x) => { const had = k(x) in db; delete db[k(x)]; save(); return had; },
    list: async ({ prefix = '' } = {}) => new Map(Object.keys(db).filter((y) => y.startsWith(k(prefix))).sort().map((y) => [y.slice(ns.length + 1), structuredClone(db[y])])),
  };
};
const objs = new Map();
const env = {
  PASS: KEY, COOKIE_SECRET: S.COOKIE_SECRET, ADMIN_TOKEN: S.ADMIN_TOKEN, WS_TOKENS: JSON.stringify(S.WS_TOKENS || {}), RESEND_KEY: '',
  BOARD: {
    idFromName: (n) => n,
    get: (id) => { if (!objs.has(id)) objs.set(id, new Board({ storage: storage(id) }, env)); const o = objs.get(id); return { fetch: (u, init) => o.fetch(u instanceof Request ? u : new Request(u, init)) }; },
  },
};

http.createServer(async (req, res) => {
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body }), env, { waitUntil() {}, passThroughOnException() {} });
    const h = {}; r.headers.forEach((v, k) => { if (k === 'set-cookie') return; h[k] = v; });
    const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    if (cookies.length) h['set-cookie'] = cookies.map((c) => c.replace(/;\s*Domain=[^;]+/i, ''));
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Slate local error: ' + (e.stack || e)); }
}).listen(PORT, () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'studio.json'), 'utf8'));
  const url = `http://localhost:${PORT}/${cfg.workspace}/${cfg.project}`;
  // opened through the pass-code link, so the browser is signed in without typing the code (it stays signed in afterwards)
  const signin = `http://localhost:${PORT}/${KEY}/${cfg.workspace}/${cfg.project}`;
  console.log(`Slate（本机）：${url}\n已经帮你登入（不用打通行码）。换一个浏览器要码的话：打开 ${path.join(ROOT, 'key.txt')}\n关掉这个视窗 / Ctrl+C 就停。`);
  if (!args.includes('--no-open')) exec((process.platform === 'darwin' ? 'open ' : process.platform === 'win32' ? 'start "" ' : 'xdg-open ') + JSON.stringify(signin));
});
