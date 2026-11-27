// Storyboard — a content-pipeline board (scripts, stages, calendar, notes, teleprompter) on one Cloudflare Worker.
// deploy.mjs uploads this file next to a generated data.js (page HTML, gate/login HTML, routes, config).
//
// URLs:  /<workspace>/<project>               board
//        /<workspace>/<project>/scripts       all scripts
//        /<workspace>/<project>/calendar      publish calendar
//        /<workspace>/<project>/reports       reports & plans
//        /<workspace>/<project>/<name>        one script (file stem without the leading date)
//        /<workspace>/<project>/api/state     stage / date / notes (Durable Object "Board", instance "board");
//                                             POST {slug, resolve: "<what changed>"} resolves the open note: it moves
//                                             into the log (history) with what changed and the box empties for new
//                                             feedback; {slug, reopen: true} puts the last resolved note back
//        /<workspace>/<project>/api/activity  GET: the change feed behind the bell (resolved notes, newest first)
//        /<workspace>/members                 member management (owners, email-login mode only)
//        /<workspace>/api/members             its API
//
// Login mode is studio.json "auth":
//   "passcode"  one shared pass code (share/key.txt) → signed cookie v1 (no identity).
//   "otp"       email + 6-digit code sent with Resend → signed cookie v2 carrying the email; access is
//               membership of the workspace (owner / editor / viewer), checked on every request, so
//               removing a member locks them out at once. Accounts live in the "accounts" instance of
//               the same Durable Object class (users, workspaces, members, invites, codes, rate limits).
// Old links /<PASS>/<file-stem> keep working in both modes: passcode mode signs the visitor in and
// redirects; otp mode only redirects (the old secret is no longer a credential) and the login page
// returns them to that script. With a custom domain the workers.dev host forwards there.
// Workspace API (per-workspace token, read + write cards of that one workspace): /api/ws/<ws>[/scripts[/<name>]|/notes] — see wsApi.
// Secrets (Worker secret bindings): PASS, COOKIE_SECRET, ADMIN_TOKEN (API token for every workspace), WS_TOKENS (JSON {ws: token}), RESEND_KEY (optional, email login).
import { SITES, GATE, LOGIN, CFG } from './data.js';

const OTP = CFG.auth === 'otp';
const WS = CFG.workspace;
const PREFIX = `/${WS}/${CFG.project}`;
const MAIN = SITES[WS];
const ROUTES = MAIN.routes;   // main workspace (legacy links, defaults)
const siteOf = (ws) => SITES[ws] || MAIN;
const SECTIONS = { scripts: '全部脚本', calendar: '发布日历', reports: '报告与计划' };
const STAGES = ['idea', 'writing', 'ready', 'reviewed', 'filmed', 'edited', 'posted', 'binned',
  'lead', 'talking', 'confirmed', 'making', 'invoiced', 'paid'];   // the last six = 经纪人 deals board (studio.json verticals[].stages)
const ROLES = ['owner', 'editor', 'viewer'];
const COOKIE = 'studio_auth';
const MAX_AGE = 60 * 60 * 24 * 365;
const SESSION_AGE = 60 * 60 * 24 * 60;
const HANDOFF_TTL = 120 * 1000;
const MIN = 60 * 1000, HOUR = 60 * MIN;
const OTP_TTL = 10 * MIN, OTP_TRIES = 5;
const SEED = { ws: WS, name: CFG.workspaceName || WS, projects: [{ slug: CFG.project, name: CFG.projectName || CFG.project }], owners: CFG.owners || [] };

const BASE_HEADERS = {
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cache-control': 'private, no-store',
};
const html = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra } });
const json = (v, status = 200, extra = {}) =>
  new Response(JSON.stringify(v), { status, headers: { ...BASE_HEADERS, 'content-type': 'application/json', ...extra } });
const redirect = (location, status = 302, extra = {}) =>
  new Response(null, { status, headers: { ...BASE_HEADERS, location, ...extra } });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => e.length <= 254 && /^[^\s@:<>"',;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/.test(e);
const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(Math.max(b.length, 2), 6)) + c);

// ---- signing -------------------------------------------------------------------------------
const enc = new TextEncoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let hmacKey = null;
const key = (env) => (hmacKey ||= crypto.subtle.importKey('raw', enc.encode(env.COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
const sign = async (env, msg) => b64u(await crypto.subtle.sign('HMAC', await key(env), enc.encode(msg)));
const verify = async (env, msg, sig) => {
  try { return await crypto.subtle.verify('HMAC', await key(env), unb64u(sig), enc.encode(msg)); } catch { return false; }
};
const cookieFlags = (age) => `Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;

// Passcode mode: v1.<exp>.<sig>, no identity.
async function passCookie(env) {
  const v = `v1.${Math.floor(Date.now() / 1000) + MAX_AGE}`;
  return `${COOKIE}=${v}.${await sign(env, 'cookie.' + v)}; ${cookieFlags(MAX_AGE)}`;
}
// OTP mode: v2.<b64u(email)>.<exp>.<sig>.
async function sessionCookie(env, email) {
  const v = `v2.${b64u(enc.encode(email))}.${Math.floor(Date.now() / 1000) + SESSION_AGE}`;
  return `${COOKIE}=${v}.${await sign(env, 'session.' + v)}; ${cookieFlags(SESSION_AGE)}`;
}
const clearCookie = `${COOKIE}=; ${cookieFlags(0)}`;
async function readCookie(req, env) {
  const raw = (req.headers.get('cookie') || '').match(/(?:^|;\s*)studio_auth=([^;]+)/);
  if (!raw) return null;
  const parts = raw[1].split('.');
  if (!OTP && parts[0] === 'v1' && parts.length === 3 && +parts[1] * 1000 > Date.now()) {
    return (await verify(env, 'cookie.v1.' + parts[1], parts[2])) ? { pass: true } : null;
  }
  if (OTP && parts[0] === 'v2' && parts.length === 4 && +parts[2] * 1000 > Date.now()) {
    if (!(await verify(env, `session.v2.${parts[1]}.${parts[2]}`, parts[3]))) return null;
    try { return { email: new TextDecoder().decode(unb64u(parts[1])) }; } catch { return null; }
  }
  return null;
}
// Compare the typed pass code through HMAC so the comparison does not leak timing.
const passOk = async (env, code) => typeof code === 'string' && code.length < 200 &&
  (await sign(env, 'pass.' + code.trim())) === (await sign(env, 'pass.' + env.PASS));

// ---- workspace API: another person's AI terminal reads and writes ONE workspace's cards ----------------------------
// /api/ws/<ws>[/scripts[/<name>] | /notes | /guide]. Token: that workspace's own token (WS_TOKENS secret, JSON
// {ws: token}, made by deploy.mjs for verticals with "api": true) or the main ADMIN_TOKEN (every workspace).
// New cards live in the workspace's board Durable Object (key card:<stem>) and show on the board next to the file
// cards; PUT on a file card stores an online copy that replaces it until DELETE. Nothing here touches other workspaces.
const CARD_MAX = 120000, CARDS_MAX = 500;
const wsTokens = (env) => { try { return JSON.parse(env.WS_TOKENS || '{}'); } catch { return {}; } };
// → 'main' (ADMIN_TOKEN, every workspace + admin calls), 'ws' (that workspace's own token) or false.
async function wsTokenOk(req, env, url, ws) {
  const t = ((req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)/i) || [])[1] || url.searchParams.get('token') || '';
  if (!t || t.length > 200) return false;
  const mine = wsTokens(env)[ws], h = await sign(env, 'ws.' + t);
  if (env.ADMIN_TOKEN && h === (await sign(env, 'ws.' + env.ADMIN_TOKEN))) return 'main';
  return !!mine && h === (await sign(env, 'ws.' + mine)) ? 'ws' : false;
}
const boardOf = (env, site) => env.BOARD.get(env.BOARD.idFromName(site === MAIN ? 'board' : 'board:' + site.ws));
const doCall = async (env, site, p, body) => (await boardOf(env, site).fetch('https://board' + p, {
  method: body ? 'POST' : 'GET', headers: { 'x-site': site.ws }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const cardsOf = async (env, site) => { try { return (await doCall(env, site, '/__cards')).cards || []; } catch { return []; } };
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, ' ').replace(/[_\s-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
const TZ_H = Number(CFG.tzHours ?? 8); // studio.json "tzHours": your UTC offset for "today" (default +8)
const myt = () => new Date(Date.now() + TZ_H * HOUR).toISOString().slice(0, 10);
const titleOf = (md) => ((String(md).match(/^# (.+)$/m) || [])[1] || '').trim();
const API_GUIDE = `Card format (Markdown). Line 1 "# <title>". Keep a script table whose voice column is named "Voice" (or 口播 / Voiceover / VO / Narration): that is what turns on the teleprompter tab. Optional columns: "Picture" (or 画面 / Shot / Visual), "Time". Sections used on the board: "## Reference videos" (real reels with numbers), "## Hook card", "## Script", "## Caption". Look at an existing card (GET /scripts/<name>) and copy its layout.`;

async function wsApi(req, env, url, path) {
  const seg = path.split('/').filter(Boolean);            // ['api','ws',ws, what?, name?]
  const ws = seg[2], what = seg[3], name = seg[4];
  const site = SITES[ws];
  if (!site) return json({ ok: false, error: 'workspace' }, 404);
  const who = await wsTokenOk(req, env, url, ws);
  if (!who) { await new Promise((r) => setTimeout(r, 400)); return json({ ok: false, error: 'token' }, 401); }
  const base = `https://${CFG.domain || url.host}${site.prefix}`;
  // Admin (main token only): raw board state + activity, and importing entries (used to merge one workspace into another).
  if (what === 'state') {
    if (who !== 'main') return json({ ok: false, error: 'forbidden' }, 403);
    if (req.method === 'GET') return json({ ok: true, ...(await doCall(env, site, '/__state/raw')) });
    if (req.method === 'POST' && name === 'import') return json(await doCall(env, site, '/__state/import', (await req.json().catch(() => null)) || {}));
    return json({ ok: false, error: 'method' }, 405);
  }
  const M = req.method;
  const by = String(req.headers.get('x-by') || url.searchParams.get('by') || ws).slice(0, 40);

  const files = Object.entries(site.routes.names).map(([n, r]) => ({ name: n, stem: r.stem, title: r.title }));
  const extra = await cardsOf(env, site);
  const extraByStem = Object.fromEntries(extra.map((c) => [c.stem, c]));
  const find = (n) => {
    const c = extra.find((x) => x.name === n || x.stem === n);
    if (c) return { card: c, file: files.find((f) => f.stem === c.stem) || null };
    const f = files.find((x) => x.name === n || x.stem === n);
    return f ? { card: null, file: f } : null;
  };
  const state = async () => (await boardOf(env, site).fetch(new Request('https://board' + site.prefix + '/api/state', { headers: { 'x-site': site.ws } }))).json();
  const view = (f, c, st, full) => {
    const s = st[(c || f).stem] || {};
    const out = { name: (c || f).name, title: c ? c.title : f.title, url: `${base}/${encodeURIComponent((c || f).name)}`,
      source: c ? (f ? 'edited-online' : 'api') : 'file', status: s.status || null, date: s.date || null,
      notes: (s.notes || '').trim() || null, resolved: s.resolved ? { at: new Date(s.resolved.at).toISOString(), by: s.resolved.by, log: s.resolved.log } : undefined,
      created: c && c.api ? c.api.created : undefined, updated: c && c.api ? c.api.updated : undefined };
    if (full) out.md = c ? c.md : null;
    return out;
  };
  const fileMd = async (f) => {
    // File cards are only inlined in the page; read the md back out of the bundled list.
    const a = site.app.indexOf('})(['), z = site.app.indexOf(', /*__SLATE_EXTRA__*/');
    if (a < 0 || z < a) return null;
    try { return (JSON.parse(site.app.slice(a + 3, z)).find((s) => s.stem === f.stem) || {}).md || null; } catch { return null; }
  };
  const readBody = async () => {
    const ct = req.headers.get('content-type') || '';
    if (/json/.test(ct)) return (await req.json().catch(() => null)) || {};
    return { md: await req.text() };
  };

  if (!what) return json({ ok: true, workspace: ws, name: site.name, board: base, stages: STAGES, guide: API_GUIDE,
    endpoints: {
      'GET /api/ws/<ws>/scripts?status=&q=': 'every card on the board with stage, date and open notes',
      'GET /api/ws/<ws>/scripts/<name>': 'one card with its Markdown (?format=md = raw Markdown)',
      'POST /api/ws/<ws>/scripts': 'new card: JSON {md, name?, date?, status?} or a raw Markdown body (first line "# title")',
      'PUT /api/ws/<ws>/scripts/<name>': 'replace a card\'s Markdown (JSON {md} or raw body). On a file card it saves an online copy that replaces it',
      'PATCH /api/ws/<ws>/scripts/<name>': 'board fields: {status, date (YYYY-MM-DD or ""), notes, resolve: "<what you changed>"}',
      'DELETE /api/ws/<ws>/scripts/<name>': 'remove a card made through the API (or drop the online copy of a file card)',
      'GET /api/ws/<ws>/notes': 'open notes on this board (feedback to act on), newest first',
    }, headers: { authorization: 'Bearer <token>', 'x-by': 'optional name shown on the board (default: the workspace)' } });

  if (what === 'guide') return json({ ok: true, guide: API_GUIDE, example: files.find((f) => !/INDEX|plan/.test(f.stem))?.name || null });

  if (what === 'notes' && M === 'GET') {
    const st = await state(), out = [];
    for (const f of files) { const c = extraByStem[f.stem]; const v = view(f, c, st); if (v.notes) out.push({ ...v, noteAt: st[f.stem]?.noteAt ? new Date(st[f.stem].noteAt).toISOString() : null }); }
    for (const c of extra) if (!files.some((f) => f.stem === c.stem)) { const v = view(null, c, st); if (v.notes) out.push({ ...v, noteAt: st[c.stem]?.noteAt ? new Date(st[c.stem].noteAt).toISOString() : null }); }
    out.sort((a, b) => String(b.noteAt).localeCompare(String(a.noteAt)));
    return json({ ok: true, count: out.length, notes: out });
  }

  if (what !== 'scripts') return json({ ok: false, error: 'unknown', see: `/api/ws/${ws}` }, 404);

  if (!name) {
    if (M === 'GET') {
      const st = await state(), q = (url.searchParams.get('q') || '').toLowerCase(), want = url.searchParams.get('status');
      let list = files.map((f) => view(f, extraByStem[f.stem], st));
      for (const c of extra) if (!files.some((f) => f.stem === c.stem)) list.push(view(null, c, st));
      if (want) list = list.filter((v) => v.status === want);
      if (q) list = list.filter((v) => (v.name + ' ' + v.title).toLowerCase().includes(q));
      return json({ ok: true, workspace: ws, count: list.length, scripts: list });
    }
    if (M !== 'POST') return json({ ok: false, error: 'method' }, 405);
    const b = await readBody(), md = String(b.md || '');
    const title = titleOf(md);
    if (!title) return json({ ok: false, error: 'md', hint: 'Markdown with a first heading line "# <title>"' }, 400);
    if (md.length > CARD_MAX) return json({ ok: false, error: 'too-big', max: CARD_MAX }, 413);
    if (extra.length >= CARDS_MAX) return json({ ok: false, error: 'full', max: CARDS_MAX }, 409);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : myt();
    const taken = new Set([...files.map((f) => f.name.toLowerCase()), ...extra.map((c) => c.name.toLowerCase()), ...['scripts', 'calendar', 'reports', 'api', 'auth', 'board', 'settings', 'new']]);
    const root = slugify(b.name) || slugify(title) || 'card-' + Date.now().toString(36);
    let n = root; for (let i = 2; taken.has(n); i++) n = `${root}-${i}`;
    const now = new Date().toISOString();
    const card = { stem: `${date}-${n}`, name: n, title, md, kind: 'script', series: '', ref: null, api: { by, created: now, updated: now } };
    await doCall(env, site, '/__cards/put', { card, event: { kind: 'created', by, log: `${by} 新增了这张稿` } });
    const status = STAGES.includes(b.status) ? b.status : 'ready';
    await doCall(env, site, '/__state', { slug: card.stem, status });
    return json({ ok: true, created: { name: n, title, status, url: `${base}/${encodeURIComponent(n)}` } }, 201);
  }

  const hit = find(name);
  if (!hit) return json({ ok: false, error: 'not-found', hint: `GET /api/ws/${ws}/scripts lists the names` }, 404);
  const { card, file } = hit;
  const stem = (card || file).stem;

  if (M === 'GET') {
    const st = await state(), v = view(file, card, st, true);
    if (!card) v.md = await fileMd(file);
    if (url.searchParams.get('format') === 'md') return new Response(v.md || '', { headers: { ...BASE_HEADERS, 'content-type': 'text/markdown; charset=utf-8' } });
    return json({ ok: true, script: v });
  }
  if (M === 'PUT') {
    const b = await readBody(), md = String(b.md || '');
    const title = titleOf(md);
    if (!title) return json({ ok: false, error: 'md', hint: 'Markdown with a first heading line "# <title>"' }, 400);
    if (md.length > CARD_MAX) return json({ ok: false, error: 'too-big', max: CARD_MAX }, 413);
    const now = new Date().toISOString();
    const next = card ? { ...card, title, md, api: { ...card.api, by, updated: now } }
      : { stem, name: file.name, title, md, kind: 'script', series: '', ref: null, api: { by, created: now, updated: now, file: true } };
    await doCall(env, site, '/__cards/put', { card: next, event: { kind: 'edited', by, log: `${by} 改了这张稿` } });
    return json({ ok: true, updated: { name: next.name, title, source: file ? 'edited-online' : 'api', url: `${base}/${encodeURIComponent(next.name)}` } });
  }
  if (M === 'PATCH') {
    const b = (await req.json().catch(() => null)) || {};
    const patch = { slug: stem, by };
    if (STAGES.includes(b.status)) patch.status = b.status;
    if (typeof b.date === 'string') patch.date = b.date;
    if (typeof b.notes === 'string') patch.notes = b.notes;
    if (typeof b.resolve === 'string') patch.resolve = b.resolve;
    if (Object.keys(patch).length === 2) return json({ ok: false, error: 'nothing', fields: ['status', 'date', 'notes', 'resolve'], stages: STAGES }, 400);
    const r = await doCall(env, site, '/__state', patch);
    return json({ ok: !!r.ok, state: r.state });
  }
  if (M === 'DELETE') {
    if (!card) return json({ ok: false, error: 'file-card', hint: 'Cards from files cannot be deleted here; PATCH {"status":"binned"} instead' }, 409);
    await doCall(env, site, '/__cards/del', { stem });
    return json({ ok: true, deleted: card.name, reverted: file ? 'back to the file version' : undefined });
  }
  return json({ ok: false, error: 'method' }, 405);
}

// One-time handoff token (old secret link on workers.dev → custom domain, passcode mode): signed,
// 2-minute expiry, nonce burnt in the Durable Object on first use. The pass code never appears in it.
async function handoffUrl(env, next) {
  const p = b64u(enc.encode(JSON.stringify({ n: crypto.randomUUID(), e: Date.now() + HANDOFF_TTL, p: next })));
  return `https://${CFG.domain}/auth/handoff?t=${p}.${await sign(env, 'handoff.' + p)}`;
}
async function redeemHandoff(env, t) {
  const [p, sig] = String(t || '').split('.');
  if (!p || !sig || !(await verify(env, 'handoff.' + p, sig))) return null;
  let tok; try { tok = JSON.parse(new TextDecoder().decode(unb64u(p))); } catch { return null; }
  if (!tok || typeof tok.n !== 'string' || !(tok.e > Date.now())) return null;
  const r = await env.BOARD.get(env.BOARD.idFromName('handoff')).fetch('https://board/__consume', {
    method: 'POST', body: JSON.stringify({ n: tok.n, e: tok.e }) });
  return (await r.json()).ok ? safeNext(tok.p) : null;
}

// Only same-site paths may be used as a post-login destination.
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') && n.length < 600 ? n : PREFIX);

// ---- accounts (Durable Object "accounts") ------------------------------------------------------
const acct = async (env, op, body = {}) =>
  (await env.BOARD.get(env.BOARD.idFromName('accounts')).fetch('https://board/__acct/' + op, {
    method: 'POST', body: JSON.stringify({ ...body, seed: SEED }) })).json();
async function whoami(req, env) {
  const c = await readCookie(req, env);
  if (!c) return null;
  if (!OTP) return { mode: 'passcode' };
  const me = await acct(env, 'me', { email: c.email, ws: WS });
  return { mode: 'otp', email: c.email, role: me.role || null, ws: WS };
}

async function sendMail(env, to, subject, htmlBody, text) {
  if (!env.RESEND_KEY) return { ok: false, error: 'no-key' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: CFG.mailFrom, to: [to], subject, html: htmlBody, text }),
    });
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, error: 'network' }; }
}
const mailShell = (title, body) => `<!doctype html><html><body style="margin:0;background:#F5F6FB;font-family:'IBM Plex Sans',-apple-system,'PingFang SC',sans-serif;color:#16172E">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#fff;border:1px solid #E7E9F4;border-radius:18px"><tr><td style="padding:26px 26px 22px">
<div style="font:600 10px/1 monospace;letter-spacing:.14em;text-transform:uppercase;color:#7A7E9C">Storyboard</div>
<h1 style="margin:14px 0 8px;font-size:21px;line-height:1.25;letter-spacing:-.02em">${title}</h1>${body}
</td></tr></table>
<p style="margin:14px 0 0;font:11px/1.5 sans-serif;color:#A9AEC4">如果这不是你本人操作，忽略这封邮件即可。</p>
</td></tr></table></body></html>`;
const codeMail = (code) => mailShell('你的登录验证码', `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#43466A">在 Storyboard 登录页输入下面的 6 位数，10 分钟内有效。</p>
<div style="padding:14px 0;border-radius:12px;background:#EDF0FF;text-align:center;font:600 30px/1 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:.32em;color:#1B34C7">${code}</div>`);
const inviteMail = (by, ws, link) => mailShell(`${esc(by)} 邀请你加入 ${esc(ws)}`, `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#43466A">用这个邮箱登录 Storyboard 就能进入工作区，不需要密码，我们会寄验证码给你。</p>
<a href="${esc(link)}" style="display:inline-block;padding:11px 18px;border-radius:11px;background:#2F54FF;color:#fff;font-weight:600;font-size:14px;text-decoration:none">打开 Storyboard</a>`);

// ---- pages ---------------------------------------------------------------------------------
const gate = (next, error = false) => html(GATE
  .replace('__NEXT__', () => esc(safeNext(next)))
  .replace('__ERROR_HIDDEN__', () => (error ? '' : 'hidden')), 401);

// Login page states: email (step 1), code (step 2), denied (signed in but not a member).
function login(state, { next, email = '', error = '', status = 401 } = {}) {
  const v = {
    next: safeNext(next), next_q: encodeURIComponent(safeNext(next)), email, masked: email ? maskEmail(email) : '', error, ws: WS,
    hide_email: state === 'email' ? '' : 'hidden', hide_code: state === 'code' ? '' : 'hidden',
    hide_denied: state === 'denied' ? '' : 'hidden', hide_error: error ? '' : 'hidden',
  };
  return html(LOGIN.replace(/\{\{(\w+)\}\}/g, (_, k) => (k.startsWith('hide_') ? v[k] : esc(v[k] ?? ''))), status);
}
const unauth = (url) => (OTP ? login('email', { next: url.pathname + url.search }) : gate(url.pathname + url.search));

function page(title, me, status = 200, site = MAIN, extra = []) {
  const client = me && me.mode === 'otp' ? { mode: 'otp', email: me.email, role: me.role, ws: WS } : { mode: 'passcode' };
  return html(site.app
    .replace('/*__SLATE_EXTRA__*/[]', () => JSON.stringify(extra.map(({ api, ...c }) => c)).replace(/</g, '\\u003c'))
    .replace('<title>Content Pipeline</title>', () => `<title>${esc(title)} · Content Pipeline</title>`)
    .replace('__SLATE_ME__', () => JSON.stringify(client).replace(/</g, '\\u003c')), status);
}

// Old /<PASS>/<file-stem> path → new path (unknown or archived stems land on the board).
function legacyTarget(rest) {
  if (!rest.length) return PREFIX;
  const s = rest.join('/');
  const name = ROUTES.stems[s] || (ROUTES.names[s] ? s : null);
  return name ? `${PREFIX}/${encodeURIComponent(name)}` : PREFIX;
}

// Each workspace has its own board instance; the main one keeps the original "board".
const board = (req, env, site = MAIN) => {
  const r = new Request(req); r.headers.set('x-site', site.ws);
  return env.BOARD.get(env.BOARD.idFromName(site === MAIN ? 'board' : 'board:' + site.ws)).fetch(r);
};
const OTP_ERRORS = {
  email: '这个邮箱格式不对。', rate: '尝试太多次了，请稍后再试。', wait: '验证码刚寄出，请等 30 秒再重新发送。',
  mail: '邮件暂时发不出去，请稍后再试。', invalid: '验证码不对。', expired: '验证码已过期，请重新发送。',
  locked: '错误次数太多，这个验证码已作废，请重新发送。',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
    path = path.replace(/\/+$/, '') || '/';
    const segs = path.split('/').filter(Boolean);
    const onWorkersDev = url.hostname.endsWith('.workers.dev');
    const read = req.method === 'GET' || req.method === 'HEAD';
    const post = req.method === 'POST';
    const ip = req.headers.get('cf-connecting-ip') || 'unknown';
    const origin = `https://${CFG.domain || url.host}`;

    // 1. Old secret links keep working.
    if (env.PASS && segs[0] === env.PASS) {
      const rest = segs.slice(1);
      if (rest.length === 2 && rest[0] === 'api' && rest[1] === 'state') {
        // Tabs still open on the very first app save through this path; the secret was its credential.
        return OTP ? json({ ok: false, error: 'auth' }, 401) : board(req, env);
      }
      const target = legacyTarget(rest);
      if (OTP) return redirect(CFG.domain && url.hostname !== CFG.domain ? `https://${CFG.domain}${target}` : target, 302);
      if (CFG.domain && url.hostname !== CFG.domain) return redirect(await handoffUrl(env, target), 302);
      return redirect(target, 302, { 'set-cookie': await passCookie(env) });
    }

    // 2. With a custom domain, the workers.dev host only forwards.
    if (CFG.domain && onWorkersDev) {
      return redirect(`https://${CFG.domain}${url.pathname}${url.search}`, read ? 301 : 308);
    }

    // 3. Public bits.
    if (path === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain' } });
    if (path === '/favicon.ico') return new Response(null, { status: 404 });
    if (path.startsWith('/api/ws/')) return wsApi(req, env, url, path);
    // A workspace merged into another (studio.json "merged"): old links land on the same card in the new board.
    if (CFG.merged && CFG.merged[segs[0]] && read) {
      const m = CFG.merged[segs[0]], to = SITES[m.into];
      if (to) {
        const rest = segs.slice(1), card = rest[0] === CFG.project && rest[1] ? rest[1] : '';
        const name = card && (m.names[card] || m.names[card.replace(/^\d{4}-\d{2}-\d{2}-/, '')]);
        return redirect(name ? `${to.prefix}/${encodeURIComponent(name)}` : to.prefix, 301);
      }
    }
    if (path === '/auth/logout') return redirect(OTP ? '/login' : PREFIX, 302, { 'set-cookie': clearCookie });

    if (!OTP) {
      if (path === '/auth' || path === '/login') {
        if (!post) return gate(url.searchParams.get('next'));
        const form = await req.formData().catch(() => null);
        const next = safeNext(form && form.get('next'));
        if (form && (await passOk(env, form.get('code')))) return redirect(next, 303, { 'set-cookie': await passCookie(env) });
        await new Promise((r) => setTimeout(r, 600));
        return gate(next, true);
      }
      if (path === '/auth/handoff') {
        const next = await redeemHandoff(env, url.searchParams.get('t'));
        if (next) return redirect(next, 302, { 'set-cookie': await passCookie(env) });
        return gate(PREFIX); // expired or already used: the pass code still works
      }
    } else {
      if (path === '/login' || path === '/auth') {
        return login('email', { next: url.searchParams.get('next'), email: normEmail(url.searchParams.get('email')), status: 200 });
      }
      if (path === '/auth/otp/start' && post) {
        const form = await req.formData().catch(() => null);
        const email = normEmail(form && form.get('email'));
        const next = safeNext(form && form.get('next'));
        if (!validEmail(email)) return login('email', { next, email, error: OTP_ERRORS.email });
        const r = await acct(env, 'otpStart', { email, ip });
        if (!r.ok) return login(r.error === 'wait' ? 'code' : 'email', { next, email, error: OTP_ERRORS[r.error] || OTP_ERRORS.rate, status: 429 });
        if (r.send) {
          const sent = await sendMail(env, email, `${r.code} 是你的 Storyboard 登录验证码`, codeMail(r.code),
            `你的 Storyboard 登录验证码：${r.code}\n10 分钟内有效。如果这不是你本人操作，忽略这封邮件即可。`);
          if (!sent.ok) { await acct(env, 'otpCancel', { email }); return login('email', { next, email, error: OTP_ERRORS.mail, status: 502 }); }
        }
        // Same answer whether or not the address has access, so the page does not reveal who is a member.
        return login('code', { next, email, status: 200 });
      }
      if (path === '/auth/otp/verify' && post) {
        const form = await req.formData().catch(() => null);
        const email = normEmail(form && form.get('email'));
        const next = safeNext(form && form.get('next'));
        const code = String((form && form.get('code')) || '').replace(/\D/g, '');
        const r = await acct(env, 'otpVerify', { email, code, ip });
        if (r.ok) return redirect(next, 303, { 'set-cookie': await sessionCookie(env, email) });
        const left = r.error === 'invalid' && r.left ? `还可以试 ${r.left} 次。` : '';
        return login(['expired', 'locked'].includes(r.error) ? 'email' : 'code', { next, email, error: (OTP_ERRORS[r.error] || OTP_ERRORS.invalid) + left });
      }
    }

    // 4. Everything else needs a session.
    const me = await whoami(req, env);
    const isApi = path.endsWith('/api/state') || path.endsWith('/api/activity') || path === `/${WS}/api/members`;
    if (!me) return isApi ? json({ ok: false, error: 'auth' }, 401) : unauth(url);
    if (OTP && !me.role) {
      return isApi ? json({ ok: false, error: 'forbidden' }, 403) : login('denied', { email: me.email, status: 403 });
    }

    const site = siteOf(segs[0]);
    const SP = site.prefix;
    if (path === SP + '/api/state') {
      if (OTP && !read && me.role === 'viewer') return json({ ok: false, error: 'read-only' }, 403);
      return board(req, env, site);
    }
    if (path === SP + '/api/activity') return read ? board(req, env, site) : json({ ok: false }, 405);
    if (path === `/${WS}/api/members`) {
      if (!OTP) return json({ ok: false, error: 'passcode-mode' }, 404);
      if (me.role !== 'owner') return json({ ok: false, error: 'forbidden' }, 403);
      if (read) return json(await acct(env, 'members', { ws: WS, by: me.email }));
      const b = await req.json().catch(() => ({}));
      const op = { invite: 'invite', role: 'role', remove: 'remove' }[b.action];
      if (!op) return json({ ok: false, error: 'action' }, 400);
      const r = await acct(env, op, { ws: WS, by: me.email, email: normEmail(b.email), role: b.role });
      if (r.ok && op === 'invite') {
        const link = `${origin}/login?email=${encodeURIComponent(normEmail(b.email))}&next=${encodeURIComponent(PREFIX)}`;
        r.mailed = (await sendMail(env, normEmail(b.email), `${me.email} 邀请你加入 ${SEED.name} · Storyboard`, inviteMail(me.email, SEED.name, link),
          `${me.email} 邀请你加入 ${SEED.name}。用这个邮箱登录即可：${link}`)).ok;
      }
      return json(r, r.ok ? 200 : 400);
    }

    if (path === '/') return redirect(PREFIX, 302);
    if (segs.length === 1 && SITES[segs[0]]) return redirect(SITES[segs[0]].prefix, 302);
    if (path === `/${WS}/members`) {
      if (!OTP) return page('找不到', me, 404);
      return page('成员', me, me.role === 'owner' ? 200 : 403);
    }
    if (path === SP || path.startsWith(SP + '/')) {
      const extra = await cardsOf(env, site);
      if (path === SP) return page('看板', me, 200, site, extra);
      const sub = path.slice(SP.length + 1);
      if (SECTIONS[sub]) return page(SECTIONS[sub], me, 200, site, extra);
      const own = extra.find((c) => c.name === sub);
      if (own) return page(own.title, me, 200, site, extra);
      if (site.routes.names[sub]) return page(site.routes.names[sub].title, me, 200, site, extra);
      // A full file stem (with its date) → the clean name.
      const name = site.routes.stems[sub] || (extra.find((c) => c.stem === sub) || {}).name;
      if (name) return redirect(`${SP}/${encodeURIComponent(name)}${url.search}`, 301);
      return page('找不到', me, 404, site, extra);
    }
    return page('找不到', me, 404);
  },
};

// ---- Durable Object --------------------------------------------------------------------------
// One class, several instances (no migration needed to add one):
//   "board"     stage / publish date / notes per script, keyed by file stem (survives URL renames).
//   "handoff"   burns one-time handoff tokens.
//   "accounts"  users, workspaces, members, invites, login codes, rate limits. Keys:
//               ws:<slug> · m:<slug>:<email> (role) · um:<email>:<slug> (reverse index)
//               inv:<slug>:<email> · uinv:<email>:<slug> · u:<email> · otp:<email> · rl:<bucket> · last:<email>
//               Ready for self-serve sign-up: a new workspace is one ws: record plus an owner m:/um: pair;
//               its board would be the "board:<slug>" instance (the original workspace keeps "board").
export class Board {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const R = siteOf(req.headers.get('x-site')).routes;
    if (p === '/__consume') {
      const { n, e } = await req.json();
      const used = (await this.ctx.storage.get('nonces')) || {};
      const now = Date.now();
      for (const k in used) if (used[k] < now) delete used[k];
      const ok = !(n in used);
      used[n] = e;
      await this.ctx.storage.put('nonces', used);
      return json({ ok });
    }
    if (p.startsWith('/__acct/')) return json(await this.acct(p.slice(8), await req.json()));
    // Cards made through the workspace API (only reachable from wsApi / page(); user requests never use these paths).
    if (p === '/__cards') return json({ cards: [...(await this.ctx.storage.list({ prefix: 'card:' })).values()] });
    if (p === '/__cards/put' || p === '/__cards/del') {
      const b = await req.json();
      if (p === '/__cards/del') {
        await this.ctx.storage.delete('card:' + b.stem);
        const feed = (await this.ctx.storage.get('activity')) || [];
        await this.ctx.storage.put('activity', feed.filter((i) => !(i.stem === b.stem && (i.kind === 'created' || i.kind === 'edited'))));
        return json({ ok: true });
      }
      await this.ctx.storage.put('card:' + b.card.stem, b.card);
      if (b.event) {
        const feed = (await this.ctx.storage.get('activity')) || [];
        feed.unshift({ id: `${Date.now()}-${b.card.stem}`, stem: b.card.stem, title: b.card.title, at: Date.now(), ...b.event });
        await this.ctx.storage.put('activity', feed.slice(0, 200));
      }
      return json({ ok: true });
    }
    if (p === '/__state/raw') return json({ state: (await this.ctx.storage.get('state')) || {}, activity: (await this.ctx.storage.get('activity')) || [] });
    if (p === '/__state/import') {
      // { entries: {stem: entry}, activity: [] } — adds entries for stems this board does not have yet (never overwrites).
      const b = await req.json(), all = (await this.ctx.storage.get('state')) || {}, added = [], skipped = [];
      for (const [k, v] of Object.entries(b.entries || {})) { if (all[k]) skipped.push(k); else { all[k] = v; added.push(k); } }
      await this.ctx.storage.put('state', all);
      if (Array.isArray(b.activity) && b.activity.length) {
        const feed = (await this.ctx.storage.get('activity')) || [];
        await this.ctx.storage.put('activity', [...feed, ...b.activity].sort((x, y) => y.at - x.at).slice(0, 200));
      }
      return json({ ok: true, added, skipped });
    }
    if (p === '/__state') return this.fetch(new Request('https://board/api/state', { method: 'POST', headers: req.headers, body: await req.text() }));
    if (req.method === 'GET' && p.endsWith('/api/activity')) {
      const items = (await this.ctx.storage.get('activity')) || [];
      const real = items.filter((i) => !String(i.stem || '').startsWith('_'));   // drop test-page items
      if (real.length !== items.length) await this.ctx.storage.put('activity', real);
      return json({ items: real });
    }
    if (req.method === 'GET') return json(await this.state(R));
    if (req.method === 'POST') {
      const b = await req.json().catch(() => null);
      if (!b || typeof b.slug !== 'string' || b.slug.length > 200) return json({ ok: false }, 400);
      const slug = R.names[b.slug] ? R.names[b.slug].stem : b.slug; // accept a clean name too
      const all = await this.state(R);
      const cur = all[slug] || {};
      const now = Date.now(), events = [];
      if (STAGES.includes(b.status)) cur.status = b.status;
      if (typeof b.date === 'string' && /^(\d{4}-\d{2}-\d{2})?$/.test(b.date)) cur.date = b.date;
      // Checklists on a page (- [ ] items): { checks: { key: true|false } } merges; a tick stores when it was ticked.
      if (b.checks && typeof b.checks === 'object' && !Array.isArray(b.checks)) {
        const c = { ...(cur.checks || {}) };
        for (const [k, v] of Object.entries(b.checks).slice(0, 50)) {
          if (typeof k !== 'string' || !k || k.length > 120) continue;
          if (v) c[k] = now; else delete c[k];
        }
        if (Object.keys(c).length <= 3000) cur.checks = c;
      }
      // The notes box holds only open feedback: anything typed there is "open" until resolved.
      if (typeof b.notes === 'string' && b.notes.slice(0, 5000) !== (cur.notes || '')) {
        cur.notes = b.notes.slice(0, 5000);
        cur.noteAt = now;
        cur.noteState = cur.notes.trim() ? 'open' : cur.resolved ? 'resolved' : undefined;
      }
      // Resolve: { resolve: "<what changed>", by?, at? (ms, to date a fix made earlier) }. The note moves into the
      // log together with what changed, and the box is emptied for the next round of feedback.
      if (typeof b.resolve === 'string' && (cur.notes || '').trim()) {
        const at = Number.isFinite(b.at) && b.at <= now && b.at > now - 30 * 864e5 ? b.at : now;
        const entry = { at, by: String(b.by || 'Claude').slice(0, 40), log: b.resolve.slice(0, 2000), note: cur.notes };
        cur.resolved = entry;
        cur.history = [...(cur.history || []), { kind: 'resolved', ...entry }].slice(-30);
        events.push({ kind: 'resolved', at: now, by: entry.by, log: entry.log, note: cur.notes.slice(0, 200) });
        cur.notes = '';
        cur.noteState = 'resolved';
      }
      // Reopen puts the last resolved note back into the box (only when the box is empty).
      if (b.reopen === true && cur.noteState === 'resolved' && cur.resolved && !(cur.notes || '').trim()) {
        cur.notes = cur.resolved.note || '';
        cur.noteState = 'open';
        cur.noteAt = now;
        cur.history = [...(cur.history || []), { kind: 'reopened', at: now, by: String(b.by || 'Owner').slice(0, 40) }].slice(-30);
      }
      cur.updated = now;
      all[slug] = cur;
      await this.ctx.storage.put('state', all);
      if (events.length && !slug.startsWith('_')) {   // _test etc. never reach the bell
        const title = (R.names[R.stems[slug]] || {}).title || ((await this.ctx.storage.get('card:' + slug)) || {}).title || slug;
        const feed = (await this.ctx.storage.get('activity')) || [];
        for (const e of events) feed.unshift({ id: `${now}-${slug}`, stem: slug, title, ...e });
        await this.ctx.storage.put('activity', feed.slice(0, 200));
      }
      return json({ ok: true, state: cur });
    }
    return json({ ok: false }, 405);
  }
  // Migrate on read: an entry stored under a clean name moves to its file stem (merged, newest wins).
  async state(R = ROUTES) {
    const all = (await this.ctx.storage.get('state')) || {};
    let moved = false;
    for (const k of Object.keys(all)) {
      // Notes resolved before the box was emptied on resolve: the text is already in the log, so clear the box.
      const e = all[k];
      if (e && e.noteState === 'resolved' && e.resolved && e.notes && e.notes === e.resolved.note) { e.notes = ''; moved = true; }
      const r = R.names[k];
      if (r && r.stem !== k) {
        const a = all[r.stem] || {}, b = all[k];
        all[r.stem] = (b.updated || 0) > (a.updated || 0) ? { ...a, ...b } : { ...b, ...a };
        delete all[k];
        moved = true;
      }
    }
    if (moved) await this.ctx.storage.put('state', all);
    return all;
  }

  // ---- accounts ----
  async acct(op, b) {
    const S = this.ctx.storage, now = Date.now();
    await this.seed(b.seed);
    const email = normEmail(b.email);
    const member = (ws, e) => S.get(`m:${ws}:${e}`);
    const isOwner = async (ws, e) => ((await member(ws, e)) || {}).role === 'owner';
    const owners = async (ws) => [...(await S.list({ prefix: `m:${ws}:` })).values()].filter((m) => m.role === 'owner').length;
    const setMember = async (ws, e, role, by) => {
      const cur = (await member(ws, e)) || { at: now, by };
      await S.put(`m:${ws}:${e}`, { ...cur, role });
      await S.put(`um:${e}:${ws}`, role);
    };
    const acceptInvites = async (e, only) => {
      for (const k of (await S.list({ prefix: `uinv:${e}:` })).keys()) {
        const ws = k.slice(`uinv:${e}:`.length);
        if (only && ws !== only) continue;
        const inv = await S.get(`inv:${ws}:${e}`);
        if (inv && !(await member(ws, e))) await setMember(ws, e, inv.role, inv.by);
        await S.delete([`inv:${ws}:${e}`, k]);
      }
    };

    switch (op) {
      case 'me': {
        if (!validEmail(email)) return { role: null };
        await acceptInvites(email, b.ws);
        return { email, role: ((await member(b.ws, email)) || {}).role || null };
      }
      case 'otpStart': {
        if (!validEmail(email)) return { ok: false, error: 'email' };
        if (!(await this.hit(`ip:start:${b.ip}`, 20, HOUR))) return { ok: false, error: 'rate' };
        if (!(await this.hit(`em:start:${email}`, 5, HOUR))) return { ok: false, error: 'rate' };
        const last = await S.get(`last:${email}`);
        if (last && now - last < 30 * 1000) return { ok: false, error: 'wait' };
        await S.put(`last:${email}`, now);
        if (Math.random() < 0.02) await this.sweep();
        const allowed = (await S.list({ prefix: `um:${email}:`, limit: 1 })).size || (await S.list({ prefix: `uinv:${email}:`, limit: 1 })).size;
        if (!allowed) return { ok: true, send: false };
        const code = sixDigits();
        await S.put(`otp:${email}`, { h: await sign(this.env, `otp.${email}.${code}`), exp: now + OTP_TTL, tries: 0 });
        return { ok: true, send: true, code };
      }
      case 'otpCancel': { await S.delete(`otp:${email}`); return { ok: true }; }
      case 'otpVerify': {
        if (!(await this.hit(`ip:verify:${b.ip}`, 30, 15 * MIN))) return { ok: false, error: 'rate' };
        const rec = await S.get(`otp:${email}`);
        if (!rec || rec.exp < now) { if (rec) await S.delete(`otp:${email}`); return { ok: false, error: 'expired' }; }
        const ok = /^\d{6}$/.test(b.code) && (await verify(this.env, `otp.${email}.${b.code}`, rec.h));
        if (!ok) {
          rec.tries++;
          if (rec.tries >= OTP_TRIES) { await S.delete(`otp:${email}`); return { ok: false, error: 'locked' }; }
          await S.put(`otp:${email}`, rec);
          return { ok: false, error: 'invalid', left: OTP_TRIES - rec.tries };
        }
        await S.delete(`otp:${email}`);
        const u = (await S.get(`u:${email}`)) || { email, createdAt: now };
        await S.put(`u:${email}`, { ...u, lastLoginAt: now });
        await acceptInvites(email);
        return { ok: true };
      }
      case 'members': {
        if (!(await isOwner(b.ws, normEmail(b.by)))) return { ok: false, error: 'forbidden' };
        const members = [];
        for (const [k, m] of await S.list({ prefix: `m:${b.ws}:` })) {
          const e = k.slice(`m:${b.ws}:`.length);
          members.push({ email: e, role: m.role, at: m.at, lastLoginAt: ((await S.get(`u:${e}`)) || {}).lastLoginAt || null });
        }
        const invites = [...(await S.list({ prefix: `inv:${b.ws}:` }))].map(([k, v]) => ({ email: k.slice(`inv:${b.ws}:`.length), role: v.role, at: v.at, by: v.by }));
        const ws = await S.get(`ws:${b.ws}`);
        return { ok: true, workspace: ws, members, invites };
      }
      case 'invite': case 'role': case 'remove': {
        const by = normEmail(b.by);
        if (!(await isOwner(b.ws, by))) return { ok: false, error: 'forbidden' };
        if (!validEmail(email)) return { ok: false, error: 'email' };
        if (op !== 'remove' && !ROLES.includes(b.role)) return { ok: false, error: 'role' };
        const m = await member(b.ws, email), inv = await S.get(`inv:${b.ws}:${email}`);
        if (op === 'invite') {
          if (m) return { ok: false, error: 'exists' };
          await S.put(`inv:${b.ws}:${email}`, { role: b.role, at: now, by });
          await S.put(`uinv:${email}:${b.ws}`, 1);
          return { ok: true };
        }
        if (m && m.role === 'owner' && (op === 'remove' || b.role !== 'owner') && (await owners(b.ws)) <= 1) return { ok: false, error: 'last-owner' };
        if (op === 'role') {
          if (m) await setMember(b.ws, email, b.role, by);
          else if (inv) await S.put(`inv:${b.ws}:${email}`, { ...inv, role: b.role });
          else return { ok: false, error: 'missing' };
          return { ok: true };
        }
        if (m) await S.delete([`m:${b.ws}:${email}`, `um:${email}:${b.ws}`]);
        else if (inv) await S.delete([`inv:${b.ws}:${email}`, `uinv:${email}:${b.ws}`]);
        else return { ok: false, error: 'missing' };
        return { ok: true };
      }
    }
    return { ok: false, error: 'op' };
  }
  // Workspace record + owners from studio.json; re-applied only when the config changes. Owners are
  // only ever added or promoted here, never removed.
  async seed(seed) {
    if (!seed || !seed.ws) return;
    const S = this.ctx.storage, sig = JSON.stringify(seed);
    if ((await S.get('seed')) === sig) return;
    const now = Date.now();
    const ws = (await S.get(`ws:${seed.ws}`)) || { slug: seed.ws, createdAt: now };
    await S.put(`ws:${seed.ws}`, { ...ws, name: seed.name, projects: seed.projects });
    for (const raw of seed.owners || []) {
      const e = normEmail(raw);
      if (!validEmail(e)) continue;
      const m = (await S.get(`m:${seed.ws}:${e}`)) || { at: now, by: 'studio.json' };
      await S.put(`m:${seed.ws}:${e}`, { ...m, role: 'owner' });
      await S.put(`um:${e}:${seed.ws}`, 'owner');
    }
    await S.put('seed', sig);
  }
  async hit(bucket, limit, windowMs) {
    const S = this.ctx.storage, now = Date.now();
    const r = (await S.get('rl:' + bucket)) || { n: 0, reset: now + windowMs };
    if (r.reset < now) { r.n = 0; r.reset = now + windowMs; }
    r.n++;
    await S.put('rl:' + bucket, r);
    return r.n <= limit;
  }
  async sweep() {
    const S = this.ctx.storage, now = Date.now(), dead = [];
    for (const [k, v] of await S.list({ prefix: 'rl:' })) if (v.reset < now) dead.push(k);
    for (const [k, v] of await S.list({ prefix: 'last:' })) if (now - v > HOUR) dead.push(k);
    for (const [k, v] of await S.list({ prefix: 'otp:' })) if (v.exp < now) dead.push(k);
    for (let i = 0; i < dead.length; i += 128) await S.delete(dead.slice(i, i + 128));
  }
}

// Uniform 6-digit code (rejection sampling, no modulo bias).
function sixDigits() {
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= 4294000000);
  return String(a[0] % 1000000).padStart(6, '0');
}
