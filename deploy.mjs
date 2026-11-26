// Slate deploy: builds the board from scripts/*.md (+ playbook/*.md) and uploads it as a Cloudflare Worker.
//
//   CLOUDFLARE_API_TOKEN=<token> node deploy.mjs          → deploys, prints the board URL
//   node deploy.mjs --dry build                           → only writes build/worker.js + build/data.js (no upload)
//
// Needs: Node 18+, a free Cloudflare account, an API token with "Workers Scripts: Edit" (+ "Workers Routes: Edit"
// and the zone's DNS if you set a custom "domain"). Set CLOUDFLARE_ACCOUNT_ID when the token sees several accounts.
//
// studio.json  "worker"      Worker name (default "slate")
//              "workspace" / "workspaceName" / "project" / "projectName"   the URL: /<workspace>/<project>
//              "verticals"   more workspaces: [{ "workspace": "brand2", "name": "Brand 2", "api": true }] → folder
//                            workspaces/<workspace>/scripts (+ /playbook); "api": true makes it its own API token
//              "domain"      null | "board.example.com" (a zone in the same Cloudflare account)
//              "auth"        "passcode" (one shared code, key.txt) | "otp" (email codes via Resend, needs
//                            RESEND_API_KEY env, "owners": [emails] and "mailFrom")
//              "tzHours"     your UTC offset, used for "today" (default 8)
// key.txt      the pass code (made on first run, gitignored). .slate-secrets.json: cookie secret + API tokens (gitignored).
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const here = (f) => path.join(ROOT, f);
const CFG = JSON.parse(fs.readFileSync(here('studio.json'), 'utf8'));
const SCRIPT = CFG.worker || 'slate';
const PREFIX = `/${CFG.workspace}/${CFG.project}`;
const AUTH = CFG.auth === 'otp' ? 'otp' : 'passcode';
const OWNERS = (CFG.owners || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
const RESEND_KEY = process.env.RESEND_API_KEY || '';
if (AUTH === 'otp' && (!RESEND_KEY || !OWNERS.length || !CFG.mailFrom)) {
  console.error('"auth": "otp" needs RESEND_API_KEY, at least one email in "owners" and "mailFrom" in studio.json.'); process.exit(1);
}
const write600 = (f, s) => fs.writeFileSync(f, s, { mode: 0o600 });
if (!fs.existsSync(here('key.txt'))) { write600(here('key.txt'), crypto.randomBytes(9).toString('base64url') + '\n'); console.log('made key.txt (your pass code)'); }
const KEY = fs.readFileSync(here('key.txt'), 'utf8').trim();
const secretsFile = here('.slate-secrets.json');
const secrets = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, 'utf8')) : {};
secrets.COOKIE_SECRET ||= crypto.randomBytes(32).toString('base64url');
secrets.ADMIN_TOKEN ||= crypto.randomBytes(24).toString('base64url');
secrets.WS_TOKENS ||= {};
for (const v of CFG.verticals || []) if (v.api && !secrets.WS_TOKENS[v.workspace]) secrets.WS_TOKENS[v.workspace] = crypto.randomBytes(24).toString('base64url');
write600(secretsFile, JSON.stringify(secrets, null, 2) + '\n');

// One workspace = a scripts folder (board cards) + a playbook folder (sidebar guide pages).
const RESERVED = new Set(['scripts', 'calendar', 'reports', 'api', 'auth', 'board', 'settings', 'new']);
function collect(sdir, pdir, docRe) {
  const taken = new Set();
  const scripts = (fs.existsSync(sdir) ? fs.readdirSync(sdir) : []).filter((f) => f.endsWith('.md')).sort().reverse().map((f) => {
    const md = fs.readFileSync(path.join(sdir, f), 'utf8');
    const stem = f.replace(/\.md$/, '');
    let name = stem.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    if (!name || RESERVED.has(name.toLowerCase()) || taken.has(name.toLowerCase())) name = stem;
    taken.add(name.toLowerCase());
    const title = (md.match(/^# (.+)$/m) || [, stem])[1].trim();
    const doc = /INDEX|series-plan|analysis|report/i.test(stem) || (docRe ? new RegExp(docRe).test(stem) : false);
    const stage = (md.match(/<!--\s*stage:\s*(\w+)\s*-->/) || [])[1] || '';   // a card can say where it starts: <!-- stage: idea -->
    return { stem, name, title, md, kind: doc ? 'doc' : 'script', series: '', ref: null, ...(stage ? { stage } : {}) };
  });
  if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir).filter((f) => f.endsWith('.md')).sort()) {
    const md = fs.readFileSync(path.join(pdir, f), 'utf8');
    let name = f.replace(/\.md$/, '').replace(/^\d+-/, '');
    if (RESERVED.has(name.toLowerCase()) || taken.has(name.toLowerCase())) name = 'playbook-' + name;
    taken.add(name.toLowerCase());
    scripts.push({ stem: 'playbook-' + name, name, title: (md.match(/^# (.+)$/m) || [, name])[1].trim(), md, kind: 'guide', series: '', ref: null });
  }
  return scripts;
}
const routesOf = (scripts) => ({
  names: Object.fromEntries(scripts.map((s) => [s.name, { stem: s.stem, title: s.title }])),
  stems: Object.fromEntries(scripts.map((s) => [s.stem, s.name])),
});
const SPACES = [{ workspace: CFG.workspace, name: CFG.workspaceName || CFG.workspace, sdir: here('scripts'), pdir: here('playbook'), board: CFG.ui || {} },
  ...(CFG.verticals || []).map((v) => ({ workspace: v.workspace, name: v.name || v.workspace,
    sdir: here(`workspaces/${v.workspace}/scripts`), pdir: here(`workspaces/${v.workspace}/playbook`), board: v.ui || {} }))];
const WSLIST = SPACES.map((w) => ({ ws: w.workspace, name: w.name, href: `/${w.workspace}/${CFG.project}` }));
const inline = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const TPL = fs.readFileSync(here('src/app.html'), 'utf8').replace('window.SLATE_ME || "Owner"', () => JSON.stringify(CFG.me || 'Owner'));
const SITES = {};
let total = 0;
for (const w of SPACES) {
  const list = collect(w.sdir, w.pdir, w.board.docsRe); total += list.length;
  const prefix = `/${w.workspace}/${CFG.project}`;
  SITES[w.workspace] = { ws: w.workspace, name: w.name, prefix, count: list.length, routes: routesOf(list),
    app: TPL.replace('__SCRIPTS__', () => inline(list))
      .replace('__CFG__', () => inline({ prefix, workspace: w.workspace, workspaceName: w.name, project: CFG.project, workspaces: WSLIST, ...w.board })) };
}
const GATE = fs.readFileSync(here('src/gate.html'), 'utf8').replace('my-studio <i>/</i> content-pipeline', () => `${CFG.workspace} <i>/</i> ${CFG.project}`);
const LOGIN = fs.readFileSync(here('src/login.html'), 'utf8');
const data = `export const SITES = ${JSON.stringify(SITES)};
export const GATE = ${JSON.stringify(GATE)};
export const LOGIN = ${JSON.stringify(LOGIN)};
export const CFG = ${JSON.stringify({ domain: CFG.domain || null, workspace: CFG.workspace, workspaceName: CFG.workspaceName || CFG.workspace,
  project: CFG.project, projectName: CFG.projectName || 'Content pipeline', auth: AUTH, owners: OWNERS, mailFrom: CFG.mailFrom || null, merged: CFG.merged || {}, tzHours: CFG.tzHours ?? 8 })};
`;
const worker = fs.readFileSync(here('src/worker.js'), 'utf8');

const dry = process.argv.indexOf('--dry');
if (dry > 0) {
  const out = path.resolve(process.argv[dry + 1] || 'build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'worker.js'), worker); fs.writeFileSync(path.join(out, 'data.js'), data);
  console.log(`built ${total} cards into ${out}`); process.exit(0);
}

const T = process.env.CLOUDFLARE_API_TOKEN;
if (!T) { console.error('Set CLOUDFLARE_API_TOKEN (Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers").'); process.exit(1); }
const cf = async (p, opts = {}) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + p, { ...opts, headers: { Authorization: 'Bearer ' + T, ...(opts.headers || {}) } });
  const j = await r.json(); if (!j.success) throw new Error(p + ' ' + JSON.stringify(j.errors)); return j.result;
};
const accounts = await cf('/accounts');
const acct = (process.env.CLOUDFLARE_ACCOUNT_ID ? accounts.find((a) => a.id === process.env.CLOUDFLARE_ACCOUNT_ID) : accounts[0] || null)?.id;
if (!acct) { console.error('No Cloudflare account found for this token (set CLOUDFLARE_ACCOUNT_ID).'); process.exit(1); }
const upload = (extra = {}) => {
  const form = new FormData();
  form.append('metadata', JSON.stringify({ main_module: 'worker.js', compatibility_date: '2026-09-01',
    bindings: [
      { type: 'durable_object_namespace', name: 'BOARD', class_name: 'Board' },
      { type: 'secret_text', name: 'PASS', text: KEY },
      { type: 'secret_text', name: 'COOKIE_SECRET', text: secrets.COOKIE_SECRET },
      { type: 'secret_text', name: 'ADMIN_TOKEN', text: secrets.ADMIN_TOKEN },
      { type: 'secret_text', name: 'WS_TOKENS', text: JSON.stringify(secrets.WS_TOKENS) },
      ...(RESEND_KEY ? [{ type: 'secret_text', name: 'RESEND_KEY', text: RESEND_KEY }] : []),
    ], ...extra }));
  form.append('worker.js', new Blob([worker], { type: 'application/javascript+module' }), 'worker.js');
  form.append('data.js', new Blob([data], { type: 'application/javascript+module' }), 'data.js');
  return cf(`/accounts/${acct}/workers/scripts/${SCRIPT}`, { method: 'PUT', body: form });
};
// The Durable Object class is created by a migration on the first deploy.
await upload().catch((e) => { if (!/migration|Board|durable/i.test(e.message)) throw e;
  return upload({ migrations: { new_tag: 'v1', new_sqlite_classes: ['Board'] } }); });
await cf(`/accounts/${acct}/workers/scripts/${SCRIPT}/subdomain`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
let host = `${SCRIPT}.${(await cf(`/accounts/${acct}/workers/subdomain`)).subdomain}.workers.dev`;
if (CFG.domain) {
  const zone = (await cf(`/zones?name=${CFG.domain.split('.').slice(-2).join('.')}`))[0];
  await cf(`/accounts/${acct}/workers/domains`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'production', hostname: CFG.domain, service: SCRIPT, zone_id: zone.id }) });
  host = CFG.domain;
}
for (const w of Object.values(SITES)) console.log(`board: https://${host}${w.prefix} (${w.count} cards)`);
console.log(`login: ${AUTH === 'otp' ? 'email code' : 'pass code in key.txt'} · API token for your AI: .slate-secrets.json ADMIN_TOKEN (see API.md)`);
