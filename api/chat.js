/* ---------------------------------------------------------------------------
   api/chat.js — Speedy Chat, the VISITOR side. Stage 1 (Sep 16 2026).

   PUBLIC, no key. A conversation is addressed by its `token` (32 hex, random),
   handed out on `start` and kept in the visitor's browser. Everything else the
   visitor can do needs that token. Agent actions (claim, reply, whisper, duty)
   are NOT here - they arrive in stage 2 behind x-id-token, in this same file.

   Actions (POST JSON, `action`):
     start  {branch, lang, page, topic?, name?, phone?, email?, website}
            -> {ok, token, id, mode: 'live'|'offline', reason, opens_at?, greeting}
     send   {token, body}                 -> {ok, id}
     poll   {token, after}                -> {ok, status, agent, messages:[...]}
     leave  {token, name?, phone?, email?, message?}
            -> {ok, lead_id}   the visitor gave up waiting / it was offline: a lead

   THE RULE THAT DECIDES EVERYTHING: a chat is LIVE only when the branch is open
   AND at least one agent is on duty with a fresh heartbeat. Otherwise the widget
   is told 'offline' on `start`, becomes the leave-a-message form, and the message
   lands in `leads` (line=chat). No visitor ever waits on an empty room, and no
   separate ticket table exists - the Leads queue is the ticket system (Saif).

   Hours: Mon-Fri 9-7, Sat 10-5, Sun 10-5 Moreno Valley ONLY; `closed_dates` in
   chat_settings closes everything for a day. All Pacific.
--------------------------------------------------------------------------- */
import { randomBytes } from 'node:crypto';
import { resolveClient, findClients, branchCode } from './_inbox.js';
import { pushTo, withdraw, pushReady } from './_push.js';

const BRANCHES = {
  mv: 'Moreno Valley', vb: 'Riverside — Van Buren', mg: 'Riverside — Magnolia', le: 'Lake Elsinore', co: 'Colton',
};
const HEARTBEAT_MS = 30 * 60 * 1000;   /* an agent unseen for 30 min is not on duty, whatever the flag says */

const sb = () => {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
};
async function sbGet(s, path) {
  const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs });
  const rows = await r.json().catch(() => null);
  return { ok: r.ok, rows: Array.isArray(rows) ? rows : [] };
}
async function sbPost(s, table, row) {
  const r = await fetch(`${s.base}/rest/v1/${table}`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' }, body: JSON.stringify([row]) });
  const rows = await r.json().catch(() => null);
  return { ok: r.ok && Array.isArray(rows) && !!rows[0], row: Array.isArray(rows) ? rows[0] : null };
}
async function sbPatch(s, path, obj) {
  const r = await fetch(`${s.base}/rest/v1/${path}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=representation' }, body: JSON.stringify(obj) });
  const rows = await r.json().catch(() => null);
  return { ok: r.ok, rows: Array.isArray(rows) ? rows : [] };
}
async function record(s, row) {
  try { await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); } catch { /* audit must not fail the action */ }
}

/* ---- small helpers ---- */
const clean = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);
const digits10 = v => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : (d.length === 10 ? d : null); };
const validToken = t => /^[0-9a-f]{32}$/.test(String(t || ''));
const enc = encodeURIComponent;

/* per-instance rate limits: a speed bump, not a wall (instances do not share memory) */
const hits = new Map();
function limited(key, max, winMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < winMs); arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

/* Pacific clock, independent of the server's zone */
export function pacificNow(d) {
  /* harness clock: never honoured on Vercel */
  if (!d) d = (process.env.CHAT_FAKE_NOW && process.env.VERCEL !== '1') ? new Date(process.env.CHAT_FAKE_NOW) : new Date();
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { dow, minutes: (Number(g('hour')) % 24) * 60 + Number(g('minute')), date: `${g('year')}-${g('month')}-${g('day')}` };
}
/* [open, close] in minutes for a branch on a weekday, or null when closed */
export function hoursFor(branch, dow) {
  if (dow >= 1 && dow <= 5) return [9 * 60, 19 * 60];
  if (dow === 6) return [10 * 60, 17 * 60];
  return branch === 'mv' ? [10 * 60, 17 * 60] : null;
}
/* is the branch open now; if not, when does it (or Moreno Valley) open next */
export function openState(branch, now, closedDates = []) {
  const closedToday = closedDates.includes(now.date);
  const h = hoursFor(branch, now.dow);
  if (!closedToday && h && now.minutes >= h[0] && now.minutes < h[1]) return { open: true };
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let i = 0; i < 8; i++) {
    const dow = (now.dow + i) % 7, hh = hoursFor(branch, dow);
    if (!hh) continue;
    if (i === 0 && (closedToday || now.minutes >= hh[1])) continue;
    if (i === 0 && now.minutes < hh[0]) return { open: false, opens_at: `today ${fmt(hh[0])}` };
    return { open: false, opens_at: `${i === 1 ? 'tomorrow' : names[dow]} ${fmt(hh[0])}` };
  }
  return { open: false, opens_at: 'soon' };
}
const fmt = m => { const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

export { alertChain, settings as chatSettings };
async function settings(s) {
  const r = await sbGet(s, 'chat_settings?select=key,value');
  const o = { claim_window_s: 60, silent_agent_s: 180, escalation_phones: [], closed_dates: [], blocked: { phones: [], ips: [] } };
  for (const row of r.rows) o[row.key] = row.value;
  return o;
}
async function anyoneOnDuty(s) {
  const since = new Date(Date.now() - HEARTBEAT_MS).toISOString();
  const r = await sbGet(s, `agent_duty?on_duty=is.true&last_seen_at=gte.${since}&select=agent_email`);
  return r.rows.length;
}

const GREET = {
  en: b => `Hi! 👋 Welcome to Speedy Insurance ${b}. What can we help you with today?`,
  es: b => `¡Hola! 👋 Bienvenido a Speedy Insurance ${b}. ¿En qué le podemos ayudar hoy?`,
};

/* the lead a conversation turns into: the transcript rides along in fields */
async function convertToLead(s, conv, extra = {}) {
  const msgs = await sbGet(s, `messages?conversation_id=eq.${conv.id}&audience=eq.visitor&select=ts,sender_kind,sender,body&order=id.asc&limit=200`);
  const transcript = msgs.rows.map(m => `${m.sender_kind === 'visitor' ? 'Visitor' : (m.sender || 'Speedy')}: ${m.body}`).join('\n').slice(0, 6000);
  const row = {
    line: 'chat', lang: conv.lang || 'en', page: conv.source_page, src: 'chat', branch: conv.branch ? (BRANCHES[conv.branch] || conv.branch) : null,
    business: null, contact: conv.visitor_name, phone: conv.visitor_phone, email: conv.visitor_email, city: null,
    notes: extra.message || null,
    fields: { conversation_id: conv.id, topic: conv.topic, status_at_conversion: conv.status, transcript, client_no: conv.client_no || null },
    ip: conv.ip, ua: conv.ua, is_test: conv.is_test === true,
  };
  const lead = await sbPost(s, 'leads', row);
  if (!lead.ok) return null;
  await record(s, { actor: 'website', kind: 'lead.new', source: 'chat', client_no: conv.client_no || null,
    payload: { lead_id: lead.row.id, line: 'chat', conversation_id: conv.id, branch: conv.branch, lang: conv.lang, is_test: conv.is_test === true } });
  return lead.row.id;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(b.action || '');
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const s = sb();
  if (!s) return res.status(500).json({ ok: false, error: 'Storage not configured' });
  if (AGENT_ACTIONS.has(action)) return agentHandler(req, res, s, b, action);

  /* ------------------------------------------------ start ------------------------------------------------ */
  if (action === 'start') {
    if (clean(b.website)) return res.status(200).json({ ok: true, token: randomBytes(16).toString('hex'), id: 0, mode: 'offline', reason: 'closed' });  /* honeypot: a plausible lie */
    if (limited('start:' + ip, 5, 60 * 1000)) return res.status(429).json({ ok: false, error: 'Too many chats from this connection' });
    const branch = BRANCHES[b.branch] ? b.branch : 'vb';
    const lang = b.lang === 'es' ? 'es' : 'en';
    const cfg = await settings(s);
    const phone = digits10(b.phone);
    if ((phone && (cfg.blocked.phones || []).includes(phone)) || (cfg.blocked.ips || []).includes(ip)) {
      return res.status(200).json({ ok: true, token: randomBytes(16).toString('hex'), id: 0, mode: 'offline', reason: 'closed' });
    }
    const now = pacificNow();
    const st = openState(branch, now, cfg.closed_dates || []);
    let mode = 'live', reason = 'open';
    if (!st.open) { mode = 'offline'; reason = 'closed'; }
    else if (!(await anyoneOnDuty(s))) { mode = 'offline'; reason = 'nobody_on_duty'; }

    /* the client match, by phone, before the agent ever looks */
    let client_no = null, link_status = 'none';
    if (phone) { const rc = await resolveClient(s, phone); client_no = rc.client_no; link_status = rc.status; }
    /* the same person's last thread, so the agent sees history */
    let previous_id = null;
    if (phone) { const p = await sbGet(s, `conversations?visitor_phone=eq.${phone}&select=id&order=id.desc&limit=1`); previous_id = p.rows[0] ? p.rows[0].id : null; }

    const token = randomBytes(16).toString('hex');
    const conv = await sbPost(s, 'conversations', {
      channel: 'web', token, source_page: clean(b.page, 200), lang, branch, topic: clean(b.topic, 60), line: BRANCH_LINE[branch] || null,
      visitor_name: clean(b.name, 80), visitor_phone: phone, visitor_email: clean(b.email, 120), client_no, link_status, previous_id,
      status: mode === 'live' ? 'waiting' : 'offline', visitor_seen_at: new Date().toISOString(),
      ip: ip || null, ua: clean(req.headers['user-agent'], 300), is_test: b.is_test === true,
    });
    if (!conv.ok) return res.status(502).json({ ok: false, error: 'Could not start the chat - please call (951) 695-1500' });
    const greeting = GREET[lang](BRANCHES[branch]);
    await sbPost(s, 'messages', { conversation_id: conv.row.id, sender_kind: 'system', audience: 'visitor', channel: 'web', body: greeting, is_test: conv.row.is_test });
    if (clean(b.topic)) await sbPost(s, 'messages', { conversation_id: conv.row.id, sender_kind: 'visitor', audience: 'visitor', channel: 'web', body: clean(b.topic, 60), is_test: conv.row.is_test });
    if (reason === 'nobody_on_duty') {
      const e = await escalate(s, cfg, `Speedy Chat: nobody is on duty and ${who(conv.row)} just arrived (${BRANCHES[branch]}). Go on duty: ${SITE}/admin/chat.html`, conv.row);
      if (e.sent) await sbPatch(s, `conversations?id=eq.${conv.row.id}`, { alerts: [{ kind: 'escalation', to: 'escalation', at: new Date().toISOString(), ok: true, reason: 'nobody_on_duty' }] });
    }
    await record(s, { actor: 'website', kind: 'chat.start', source: 'chat', client_no,
      payload: { conversation_id: conv.row.id, branch, lang, mode, reason, topic: clean(b.topic, 60), is_test: conv.row.is_test } });
    return res.status(200).json({ ok: true, token, id: conv.row.id, mode, reason, opens_at: st.opens_at || null, greeting, client_known: !!client_no });
  }

  /* everything below needs the token */
  if (!validToken(b.token)) return res.status(400).json({ ok: false, error: 'Bad token' });
  const cv = await sbGet(s, `conversations?token=eq.${b.token}&select=*&limit=1`);
  const conv = cv.rows[0];
  if (!conv) return res.status(404).json({ ok: false, error: 'No such chat' });

  /* ------------------------------------------------ send ------------------------------------------------ */
  if (action === 'send') {
    const body = clean(b.body, 2000);
    if (!body) return res.status(400).json({ ok: false, error: 'Empty message' });
    if (conv.status === 'closed') return res.status(409).json({ ok: false, error: 'closed' });
    if (limited('send:' + conv.id, 30, 60 * 1000)) return res.status(429).json({ ok: false, error: 'Slow down' });
    const m = await sbPost(s, 'messages', { conversation_id: conv.id, sender_kind: 'visitor', audience: 'visitor', channel: 'web', body, is_test: conv.is_test });
    if (!m.ok) return res.status(502).json({ ok: false, error: 'Could not send' });
    await sbPatch(s, `conversations?id=eq.${conv.id}`, { visitor_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (conv.status === 'active' && conv.claimed_by) await pushOwner(s, conv, 'msg', `${who(conv)}: new message`, body);
    return res.status(200).json({ ok: true, id: m.row.id });
  }

  /* ------------------------------------------------ poll ------------------------------------------------ */
  if (action === 'poll') {
    const after = Math.max(0, Number(b.after) || 0);
    const ms = await sbGet(s, `messages?conversation_id=eq.${conv.id}&audience=eq.visitor&id=gt.${after}&select=id,ts,sender_kind,sender,body&order=id.asc&limit=100`);
    await sbPatch(s, `conversations?id=eq.${conv.id}`, { visitor_seen_at: new Date().toISOString() });
    let agent = null;
    if (conv.claimed_by) {
      const a = await sbGet(s, `agents?email=eq.${enc(conv.claimed_by)}&select=full_name,branch&limit=1`);
      agent = a.rows[0] ? { name: String(a.rows[0].full_name || '').split(' ')[0], branch: a.rows[0].branch || null } : { name: 'Agent', branch: null };
    }
    /* a live chat nobody claimed within the window: tell the widget to offer the form.
       (Stage 2 texts the on-duty chain during this window; the fallback is the same.) */
    const cfg = await settings(s);
    const waitedS = (Date.now() - new Date(conv.created_at).getTime()) / 1000;
    const stale = conv.status === 'waiting' && waitedS > (Number(cfg.claim_window_s) || 60) * 3;
    if (conv.status === 'waiting' && !stale) await alertChain(s, conv, cfg);
    return res.status(200).json({ ok: true, status: stale ? 'missed' : conv.status, agent, messages: ms.rows.map(m => ({ id: m.id, ts: m.ts, from: m.sender_kind, name: m.sender_kind === 'agent' ? (agent && agent.name) : null, body: m.body })) });
  }

  /* ------------------------------------------------ leave ------------------------------------------------ */
  if (action === 'leave') {
    if (conv.lead_id) return res.status(200).json({ ok: true, lead_id: conv.lead_id, already: true });
    const patch = { updated_at: new Date().toISOString() };
    const phone = digits10(b.phone); if (phone) patch.visitor_phone = phone;
    if (clean(b.name)) patch.visitor_name = clean(b.name, 80);
    if (clean(b.email)) patch.visitor_email = clean(b.email, 120);
    if (!(phone || conv.visitor_phone) && !(clean(b.email) || conv.visitor_email)) return res.status(400).json({ ok: false, error: 'A 10-digit phone number or an email is needed', code: 'need_phone' });
    const message = clean(b.message, 2000);
    if (message) await sbPost(s, 'messages', { conversation_id: conv.id, sender_kind: 'visitor', audience: 'visitor', channel: 'web', body: message, is_test: conv.is_test });
    if (phone && !conv.client_no) { const rc = await resolveClient(s, phone); if (rc.client_no) { patch.client_no = rc.client_no; patch.link_status = rc.status; } }
    /* a waiting chat that gave up is 'missed'; an offline one stays 'offline'; both close */
    /* outcome remembers HOW it became a lead: 'missed' (we were open and nobody took it)
       or 'lead' (offline by hours or duty). Reports count the first one. */
    patch.outcome = (conv.status === 'waiting' || conv.status === 'active') ? 'missed' : 'lead';
    patch.closed_at = new Date().toISOString(); patch.closed_by = 'visitor';
    const merged = { ...conv, ...patch };
    const lead_id = await convertToLead(s, merged, { message });
    if (!lead_id) return res.status(502).json({ ok: false, error: 'Could not save - please call (951) 695-1500' });
    patch.lead_id = lead_id; patch.status = 'closed';
    await sbPatch(s, `conversations?id=eq.${conv.id}`, patch);
    await record(s, { actor: 'website', kind: 'chat.left', source: 'chat', client_no: merged.client_no || null,
      payload: { conversation_id: conv.id, lead_id, was: conv.status, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, lead_id });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}

/* ===========================================================================
   AGENT SIDE (stage 2, Sep 16 2026) — behind x-id-token, the portal's Google token.
   Same identity rules as platform.js: aud must be our client id, email verified,
   @speedyins.com, and an ACTIVE row in `agents`. admin = role admin | owner.

   Actions: inbox, inbox_count, thread, claim, unclaim, reply, handoff, close, duty,
            takeover (admin), set_setting (admin)
   The SMS chain (who gets texted when) lives in alertChain(), driven by the visitor's
   own poll while the chat is waiting - no cron, and it runs exactly while someone
   is actually waiting.
   =========================================================================== */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const AGENT_ACTIONS = new Set(['inbox', 'inbox_count', 'thread', 'claim', 'unclaim', 'reply', 'handoff', 'close', 'duty', 'takeover', 'set_setting', 'media', 'find_client', 'link', 'unlink', 'set_policy', 'client_log', 'push_subscribe', 'push_unsubscribe', 'mute', 'sms_alerts', 'search']);
const SITE = 'https://www.speedyins.com';
const VISITOR_GONE_MS = 2 * 60 * 1000;
const ESCALATION_THROTTLE_MS = 15 * 60 * 1000;

/* tokeninfo once per token, not once per 3-second poll */
const tokCache = new Map();
async function verifyAgent(req, s) {
  const tok = String(req.headers['x-id-token'] || '');
  if (!tok) return null;
  let c = tokCache.get(tok);
  if (!c || c.exp < Date.now()) {
    try {
      const g = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok));
      const j = await g.json();
      if (!g.ok || j.aud !== GOOGLE_CLIENT_ID || String(j.email_verified) !== 'true') return null;
      const email = String(j.email || '').toLowerCase();
      if (!email.endsWith('@speedyins.com')) return null;
      c = { email, exp: Math.min(Number(j.exp) * 1000, Date.now() + 10 * 60 * 1000) };
      tokCache.set(tok, c); if (tokCache.size > 500) tokCache.clear();
    } catch { return null; }
  }
  const a = await sbGet(s, `agents?email=eq.${enc(c.email)}&active=is.true&select=email,full_name,branch,role,grants&limit=1`);
  if (!a.rows[0]) return null;
  const r = a.rows[0];
  const admin = r.role === 'admin' || r.role === 'owner', grants = Array.isArray(r.grants) ? r.grants : [];
  /* sms_all is a Staff-page pill (platform.js ROLE_CAPS): sees every branch's texts */
  return { email: c.email, name: r.full_name || c.email, first: String(r.full_name || c.email).split(' ')[0], branch: r.branch || null, branch_code: branchCode(r.branch), admin, sees_all: admin || grants.includes('sms_all') };
}

/* Who may see a MIRROR thread (a text on an agent's own direct number). Sep 17, Saif:
   "by default sms show to all agents per branches" - the whole branch sees its texts.
     owners/admins            everything
     sms_all (Staff pill)     every branch
     everyone else            their own number + the numbers of their home branch
     sms_private (Staff pill, on the number's OWNER)  that number is theirs + owners/admins only
   Branch-line threads are visibility 'all' and never come through here. */
async function privateLines(s) {
  const a = await sbGet(s, 'agents?active=is.true&select=email,grants');
  const priv = a.rows.filter(r => Array.isArray(r.grants) && r.grants.includes('sms_private')).map(r => r.email);
  if (!priv.length) return new Set();
  const n = await sbGet(s, `rc_numbers?agent_email=in.(${priv.map(enc).join(',')})&select=phone10`);
  return new Set(n.rows.map(r => r.phone10));
}
const canSee = (c, me, priv) => c.visibility !== 'owner' || me.admin || c.claimed_by === me.email
  || (!priv.has(c.line) && (me.sees_all || (!!c.branch && c.branch === me.branch_code)));

async function smsSend(to, text, from) {
  /* through our own /api/sms with the admin key: one RingCentral auth flow in the codebase */
  const key = process.env.ADMIN_API_KEY || process.env.ADMIN_KEY;
  if (!key) return { ok: false, error: 'ADMIN_API_KEY not set' };
  try {
    const r = await fetch(`${SITE}/api/sms`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-key': key }, body: JSON.stringify({ action: 'send', to, text: text.slice(0, 1000), purpose: 'chat', from: from || undefined }) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
const chatLink = id => `${SITE}/admin/chat.html#c=${id}`;
/* the branch lines the website prints: a web chat texts from its branch's number */
const BRANCH_LINE = { mv: '9514720927', vb: '9516951500', mg: '9519779400', le: '9515794095', co: '9095876001' };
const who = conv => conv.visitor_name || (conv.channel === 'sms' && conv.visitor_phone ? `a text from (${conv.visitor_phone.slice(0, 3)}) ${conv.visitor_phone.slice(3, 6)}-${conv.visitor_phone.slice(6)}` : (conv.lang === 'es' ? 'a Spanish-speaking visitor' : 'a visitor'));

/* on-duty agents with a fresh heartbeat and a mobile, with names */
async function dutyRoster(s) {
  const since = new Date(Date.now() - HEARTBEAT_MS).toISOString();
  const d = await sbGet(s, `agent_duty?on_duty=is.true&last_seen_at=gte.${since}&select=agent_email,mobile,since,last_seen_at,muted_until,sms_alerts&order=since.asc`);
  const emails = d.rows.map(r => r.agent_email);
  const names = {};
  if (emails.length) { const a = await sbGet(s, `agents?email=in.(${emails.map(enc).join(',')})&select=email,full_name`); for (const r of a.rows) names[r.email] = r.full_name; }
  const nowMs = Date.now();
  return d.rows.map(r => ({ email: r.agent_email, name: names[r.agent_email] || r.agent_email, first: String(names[r.agent_email] || r.agent_email).split(' ')[0], mobile: r.mobile, since: r.since,
    /* muted = on duty but not to be alerted (Sep 18): the chain skips them, the roster shows it */
    muted: !!(r.muted_until && new Date(r.muted_until).getTime() > nowMs), muted_until: r.muted_until || null, sms_alerts: r.sms_alerts !== false }));
}

/* ---- push (Sep 18): the same moments that text an agent also push to their devices.
   Every push is a no-op without VAPID keys or devices; nothing here can fail a request. */
const convUrl = id => `/admin/chat.html#c=${id}`;
const shortBody = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 140);
async function lastVisitorLine(s, id) { const m = await sbGet(s, `messages?conversation_id=eq.${id}&sender_kind=eq.visitor&audience=eq.visitor&select=body&order=id.desc&limit=1`); return m.rows[0] ? shortBody(m.rows[0].body) : ''; }
async function adminEmails(s) { const a = await sbGet(s, 'agents?active=is.true&role=in.(admin,owner)&select=email'); return a.rows.map(r => r.email); }
/* a chat someone just took: close its alert on every other phone */
async function withdrawAlerts(s, conv, except) {
  if (conv.is_test) return;
  const alerts = Array.isArray(conv.alerts) ? conv.alerts : [];
  let emails = alerts.filter(a => a.kind === 'agent' && a.to).map(a => a.to);
  if (alerts.some(a => a.kind === 'escalation')) emails = emails.concat(await adminEmails(s));
  emails = emails.filter(e => e !== except);
  if (emails.length) await withdraw(s, emails, 'c' + conv.id);
}
/* the thread's owner hears about a new visitor message / a whisper on their thread */
export async function pushOwner(s, conv, kind, title, body) {
  if (!conv || !conv.claimed_by || conv.is_test) return { sent: 0 };
  return pushTo(s, [conv.claimed_by], { type: kind, tag: 'c' + conv.id + (kind === 'whisper' ? 'w' : 'm'), title, body: shortBody(body), url: convUrl(conv.id), id: conv.id });
}

async function escalate(s, cfg, text, conv) {
  const phones = Array.isArray(cfg.escalation_phones) ? cfg.escalation_phones : [];
  const last = Number(cfg.last_escalation_at || 0);
  if (!phones.length) return { sent: 0, reason: 'no_escalation_phones' };
  if (Date.now() - last < ESCALATION_THROTTLE_MS) return { sent: 0, reason: 'throttled' };
  let sent = 0;
  let lastErr = null;
  for (const p of phones) { if (conv && conv.is_test) { sent++; continue; } const r = await smsSend(p, text); if (r && r.ok) sent++; else lastErr = String((r && r.error) || 'send failed'); }
  await fetch(`${s.base}/rest/v1/chat_settings`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: 'last_escalation_at', value: Date.now() }]) });
  return { sent, reason: lastErr };
}

/* the chain: first on-duty agent now; the next one after the claim window; then
   escalation, once. Called from the visitor's poll while status is waiting. */
async function alertChain(s, conv, cfg) {
  const alerts = Array.isArray(conv.alerts) ? conv.alerts.slice() : [];
  const window = (Number(cfg.claim_window_s) || 60) * 1000;
  const last = alerts.length ? alerts[alerts.length - 1] : null;
  if (last && Date.now() - new Date(last.at).getTime() < window) return null;   /* still inside the current window */
  const roster = await dutyRoster(s);
  const tried = new Set(alerts.filter(a => a.kind === 'agent').map(a => a.to));
  const next = roster.find(a => !tried.has(a.email) && !a.muted);
  let entry;
  const headline = `${who(conv)} is waiting · ${BRANCHES[conv.branch] || conv.branch}${conv.topic ? ' · ' + conv.topic : ''}`;
  if (next) {
    const text = `Speedy Chat: ${who(conv)} is waiting (${BRANCHES[conv.branch] || conv.branch}${conv.topic ? ' · ' + conv.topic : ''}). Claim it: ${chatLink(conv.id)}`;
    /* the text goes unless they switched it off in Alerts (push carries it then); a push
       goes to every device they turned on. Neither for a test chat. */
    const r = (conv.is_test || !next.mobile || next.sms_alerts === false) ? { ok: !!next.mobile, skipped: true } : await smsSend(next.mobile, text);
    const push = conv.is_test ? { sent: 0 } : await pushTo(s, [next.email], { type: 'alert', tag: 'c' + conv.id, title: headline, body: await lastVisitorLine(s, conv.id), url: convUrl(conv.id), id: conv.id, claim: true });
    entry = { kind: 'agent', to: next.email, at: new Date().toISOString(), ok: !!(r && r.ok), error: (r && r.ok) ? null : String((r && r.error) || 'send failed'), push: push.sent || 0, sms: !r.skipped };
  } else if (!alerts.some(a => a.kind === 'escalation')) {
    const r = await escalate(s, cfg, `Speedy Chat: nobody claimed ${who(conv)} (${BRANCHES[conv.branch] || conv.branch}) after ${alerts.length} agent alert${alerts.length === 1 ? '' : 's'}. ${chatLink(conv.id)}`, conv);
    const push = conv.is_test ? { sent: 0 } : await pushTo(s, await adminEmails(s), { type: 'escalation', tag: 'c' + conv.id, title: `Nobody claimed ${who(conv)} (${BRANCHES[conv.branch] || conv.branch}) after ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`, body: 'Escalation · tap to take it', url: convUrl(conv.id), id: conv.id, claim: true });
    entry = { kind: 'escalation', to: 'escalation', at: new Date().toISOString(), ok: r.sent > 0 || push.sent > 0, reason: r.reason || null, push: push.sent || 0 };
  } else return null;
  alerts.push(entry);
  await sbPatch(s, `conversations?id=eq.${conv.id}`, { alerts, updated_at: new Date().toISOString() });
  await record(s, { actor: 'system', kind: 'chat.alert', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: conv.id, ...entry, is_test: conv.is_test } });
  return entry;
}

async function sysMsg(s, conv, body, audience = 'visitor') {
  return sbPost(s, 'messages', { conversation_id: conv.id, sender_kind: 'system', audience, channel: 'web', body, is_test: conv.is_test });
}
const secs = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
/* an unclaimed waiting chat belongs to whoever acts on it first: replying IS claiming */
/* {kind: policy|new_quote|general, number, carrier, lob, expires} - only those keys, capped */
function cleanPolicy(p) {
  if (!p || typeof p !== 'object') return null;
  const kind = ['policy', 'new_quote', 'general'].includes(p.kind) ? p.kind : null; if (!kind) return null;
  const out = { kind };
  if (kind === 'policy') { out.number = clean(p.number, 40); out.carrier = clean(p.carrier, 60); out.lob = clean(p.lob, 40); out.expires = clean(p.expires, 20); if (!out.number && !out.carrier) return null; }
  return out;
}
const canAct = (conv, me) => me.admin || conv.claimed_by === me.email || (conv.status === 'waiting' && !conv.claimed_by);

/* the queue row, one shape for the inbox and the search (Sep 18). lastAndUnread() reads
   the visitor-facing messages once for a set of threads; rowOf() is the row itself. */
async function lastAndUnread(s, convs) {
  const ids = convs.map(c => c.id);
  const lastMsg = {}, unread = {};
  if (ids.length) {
    const ms = await sbGet(s, `messages?conversation_id=in.(${ids.join(',')})&audience=eq.visitor&select=conversation_id,ts,sender_kind,body&order=id.desc&limit=2000`);
    for (const m of ms.rows) {
      if (!lastMsg[m.conversation_id]) lastMsg[m.conversation_id] = { ts: m.ts, from: m.sender_kind, body: String(m.body || '').slice(0, 140) };
      const c = convs.find(x => x.id === m.conversation_id);
      if (c && m.sender_kind === 'visitor' && (!c.agent_seen_at || m.ts > c.agent_seen_at)) unread[m.conversation_id] = (unread[m.conversation_id] || 0) + 1;
    }
  }
  return { lastMsg, unread };
}
async function firstNames(s, emails) {
  const names = {}; const list = [...new Set(emails.filter(Boolean))];
  if (list.length) { const a = await sbGet(s, `agents?email=in.(${list.map(enc).join(',')})&select=email,full_name`); for (const r of a.rows) names[r.email] = String(r.full_name || r.email).split(' ')[0]; }
  return names;
}
const rowOf = (c, names, lastMsg, unread, now) => ({
  id: c.id, status: c.status, outcome: c.outcome, created_at: c.created_at, closed_at: c.closed_at || null, updated_at: c.updated_at || null, branch: c.branch, branch_name: BRANCHES[c.branch] || c.branch, lang: c.lang, topic: c.topic,
  channel: c.channel || 'web', line: c.line || null, visibility: c.visibility || 'all',
  name: c.visitor_name, phone: c.visitor_phone, client_no: c.client_no, claimed_by: c.claimed_by, claimed_name: names[c.claimed_by] || null, claimed_at: c.claimed_at,
  waited_s: c.status === 'waiting' ? secs(c.created_at, now) : (c.claimed_at ? secs(c.created_at, c.claimed_at) : null),
  last: lastMsg[c.id] || null, unread: unread[c.id] || 0, lead_id: c.lead_id, visitor_here: !!c.visitor_seen_at && (Date.now() - new Date(c.visitor_seen_at).getTime()) < VISITOR_GONE_MS,
  alerts: (c.alerts || []).length, is_test: c.is_test,
});

/* the client card: who this phone is, what they hold, what they last paid */
async function clientCard(s, conv) {
  if (!conv.client_no) return null;
  const [c, p, pay] = await Promise.all([
    sbGet(s, `clients?client_no=eq.${conv.client_no}&select=client_no,first_name,last_name,business_name,branch,phone,city,extras&limit=1`),
    sbGet(s, `policies?client_no=eq.${conv.client_no}&select=policy_number,lob,carrier,expiration_date,status,premium&order=expiration_date.desc&limit=5`),
    sbGet(s, `bridge_ledger?client_id=eq.${conv.client_no}&is_test=is.false&select=ts,amount,purpose,audit_status,carrier_name,total_owed&order=ts.desc&limit=1`),
  ]);
  const cl = c.rows[0]; if (!cl) return { client_no: conv.client_no };
  return {
    client_no: conv.client_no, name: cl.business_name || [cl.first_name, cl.last_name].filter(Boolean).join(' '), branch: cl.branch, city: cl.city, phone: cl.phone,
    producer: cl.extras && cl.extras.producer ? cl.extras.producer : null,
    policies: p.rows.map(x => ({ number: x.policy_number, lob: x.lob, carrier: x.carrier, expires: x.expiration_date, status: x.status, premium: x.premium })),
    last_payment: pay.rows[0] ? { ts: pay.rows[0].ts, amount: pay.rows[0].amount, purpose: pay.rows[0].purpose, audit: pay.rows[0].audit_status, carrier: pay.rows[0].carrier_name, owed: pay.rows[0].total_owed } : null,
  };
}

async function agentHandler(req, res, s, b, action) {
  const me = await verifyAgent(req, s);
  if (!me) return res.status(401).json({ ok: false, error: 'Not authorized' });
  const now = new Date().toISOString();
  const cfg = await settings(s);

  /* the light one for the portal badge: counts only, and a heartbeat ONLY if already on duty */
  if (action === 'inbox_count') {
    const [w, m, d] = await Promise.all([
      sbGet(s, 'conversations?status=eq.waiting&select=id'),
      sbGet(s, `conversations?status=eq.active&claimed_by=eq.${enc(me.email)}&select=id`),
      sbGet(s, `agent_duty?agent_email=eq.${enc(me.email)}&select=on_duty,mobile&limit=1`),
    ]);
    const duty = d.rows[0] || { on_duty: false, mobile: null };
    if (duty.on_duty) await sbPatch(s, `agent_duty?agent_email=eq.${enc(me.email)}`, { last_seen_at: now });
    return res.status(200).json({ ok: true, waiting: w.rows.length, mine: m.rows.length, on_duty: !!duty.on_duty });
  }

  /* ---- search (Sep 18): a phone (any digits), a name, or a word said in the conversation,
     across ALL time - closed threads from last week included. The same visibility as
     the inbox; optional channel / agent narrowing. Rows come back in the queue's shape
     plus `match`: the message line that matched, for the highlight. ---- */
  if (action === 'search') {
    const q = String(clean(b.q, 80) || '').replace(/[,()*\\]/g, ' ').trim();
    const digits = q.replace(/\D/g, '');
    const allDigits = /^[\d\s().+-]+$/.test(q);   /* typed as a number, not a word with a digit in it */
    const byPhone = allDigits && digits.length >= 3;
    if (q.length < 2 || (allDigits && digits.length < 3)) return res.status(400).json({ ok: false, error: 'Type at least 2 letters or 3 digits' });
    const channel = ['web', 'sms'].includes(b.channel) ? b.channel : null;
    const agent = String(clean(b.agent, 120) || '').toLowerCase();
    const narrow = (channel ? `&channel=eq.${channel}` : '') + (agent ? `&claimed_by=eq.${enc(agent)}` : '');
    let ors, matchBy = {};
    if (byPhone) ors = `visitor_phone.like.*${digits}*`;
    else {
      const hits = await sbGet(s, `messages?body=ilike.*${enc(q)}*&audience=eq.visitor&select=conversation_id,body&order=id.desc&limit=400`);
      for (const m of hits.rows) if (!matchBy[m.conversation_id]) matchBy[m.conversation_id] = String(m.body || '').slice(0, 160);
      const ids = Object.keys(matchBy).slice(0, 200);
      ors = `visitor_name.ilike.*${enc(q)}*` + (ids.length ? `,id.in.(${ids.join(',')})` : '');
    }
    const cv = await sbGet(s, `conversations?or=(${ors})${narrow}&select=*&order=updated_at.desc.nullslast,id.desc&limit=40`);
    const priv = await privateLines(s);
    const convs = cv.rows.filter(x => canSee(x, me, priv));
    const { lastMsg, unread } = await lastAndUnread(s, convs);
    const names = await firstNames(s, convs.map(c => c.claimed_by));
    return res.status(200).json({ ok: true, q, by: byPhone ? 'phone' : 'text', results: convs.map(c => ({ ...rowOf(c, names, lastMsg, unread, now), match: matchBy[c.id] || null })) });
  }

  if (action === 'inbox') {
    /* heartbeat: the inbox open IS being present */
    await fetch(`${s.base}/rest/v1/agent_duty`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ agent_email: me.email, last_seen_at: now, updated_at: now }]) });
    const dayStart = new Date(); dayStart.setUTCHours(dayStart.getUTCHours() - 7); dayStart.setUTCHours(7, 0, 0, 0);   /* Pacific midnight, approx */
    const [open, closed, dutyRow, roster, devices] = await Promise.all([
      sbGet(s, 'conversations?status=in.(waiting,active)&select=*&order=created_at.asc&limit=100'),
      sbGet(s, `conversations?status=in.(closed,missed,offline)&updated_at=gte.${dayStart.toISOString()}&select=*&order=updated_at.desc&limit=50`),
      sbGet(s, `agent_duty?agent_email=eq.${enc(me.email)}&select=on_duty,mobile,since,muted_until,sms_alerts&limit=1`),
      dutyRoster(s),
      sbGet(s, `push_subscriptions?agent_email=eq.${enc(me.email)}&select=id,label,endpoint,created_at&order=created_at.asc`),
    ]);
    const myDuty = dutyRow.rows[0] || {};
    const mutedUntil = myDuty.muted_until && new Date(myDuty.muted_until).getTime() > Date.now() ? myDuty.muted_until : null;
    /* mirror threads: the owner, their branch, sms_all, admins - see canSee() */
    const priv = await privateLines(s);
    open.rows = open.rows.filter(x => canSee(x, me, priv)); closed.rows = closed.rows.filter(x => canSee(x, me, priv));
    /* a text waiting on a branch line has no visitor poll to drive the chain: the inbox does it */
    for (const c of open.rows) { if (c.status === 'waiting' && c.channel === 'sms') { try { await alertChain(s, c, cfg); } catch { /* next poll */ } } }
    const convs = open.rows.concat(closed.rows);
    const { lastMsg, unread } = await lastAndUnread(s, convs);
    const names = await firstNames(s, convs.map(c => c.claimed_by));
    const row = c => rowOf(c, names, lastMsg, unread, now);
    return res.status(200).json({ ok: true,
      me: { email: me.email, name: me.name, first: me.first, admin: me.admin, sees_all: me.sees_all, branch: me.branch_code, on_duty: !!myDuty.on_duty, mobile: myDuty.mobile || null, since: myDuty.since || null,
        muted_until: mutedUntil, sms_alerts: myDuty.sms_alerts !== false, push_devices: devices.rows.map(d => ({ id: d.id, label: d.label || 'device', endpoint: d.endpoint, created_at: d.created_at })) },
      waiting: open.rows.filter(c => c.status === 'waiting').map(row),
      mine: open.rows.filter(c => c.status === 'active' && c.claimed_by === me.email).map(row),
      team: open.rows.filter(c => c.status === 'active' && c.claimed_by !== me.email).map(row),
      closed: closed.rows.map(row),
      on_duty: roster.map(r => ({ email: r.email, name: r.first, since: r.since, muted: r.muted })),
      settings: Object.assign(me.admin ? { claim_window_s: cfg.claim_window_s, silent_agent_s: cfg.silent_agent_s, escalation_phones: cfg.escalation_phones, closed_dates: cfg.closed_dates, blocked: cfg.blocked } : { claim_window_s: cfg.claim_window_s },
        { push_ready: pushReady(), vapid_public: process.env.VAPID_PUBLIC || null }),
    });
  }

  if (action === 'duty') {
    const on = b.on === true;
    const cur = await sbGet(s, `agent_duty?agent_email=eq.${enc(me.email)}&select=mobile,on_duty&limit=1`);
    let mobile = cur.rows[0] ? cur.rows[0].mobile : null;
    if (b.mobile != null && String(b.mobile).trim()) { const d = digits10(b.mobile); if (!d) return res.status(400).json({ ok: false, error: 'A 10-digit mobile number is needed', code: 'need_mobile' }); mobile = '+1' + d; }
    if (on && !mobile) return res.status(400).json({ ok: false, error: 'Enter the mobile number that should be texted when a chat arrives', code: 'need_mobile' });
    await fetch(`${s.base}/rest/v1/agent_duty`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ agent_email: me.email, on_duty: on, since: on ? now : null, mobile, last_seen_at: now, updated_at: now, ...(on ? { muted_until: null } : {}) }]) });
    await record(s, { actor: me.email, kind: on ? 'chat.duty_on' : 'chat.duty_off', source: 'chat', client_no: null, payload: { mobile_set: !!mobile } });
    return res.status(200).json({ ok: true, on_duty: on, mobile });
  }

  /* ---- Alerts (Sep 18): push devices, mute, the SMS switch ---- */
  if (action === 'push_subscribe') {
    const sub = b.subscription && typeof b.subscription === 'object' ? b.subscription : null;
    const endpoint = sub ? String(sub.endpoint || '') : '';
    const keys = sub && sub.keys && typeof sub.keys === 'object' ? sub.keys : {};
    if (!/^https:\/\/[^\s]{10,1900}$/.test(endpoint) || !keys.p256dh || !keys.auth) return res.status(400).json({ ok: false, error: 'Bad subscription' });
    const label = clean(b.label, 60) || 'device';
    /* the endpoint is the device: re-subscribing the same one updates its keys and owner */
    const r = await fetch(`${s.base}/rest/v1/push_subscriptions?on_conflict=endpoint`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{ agent_email: me.email, endpoint, p256dh: String(keys.p256dh).slice(0, 200), auth: String(keys.auth).slice(0, 100), label, last_ok_at: now, fails: 0 }]) });
    const rows = await r.json().catch(() => []);
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Could not save the device' });
    await record(s, { actor: me.email, kind: 'chat.push_on', source: 'chat', client_no: null, payload: { label } });
    return res.status(200).json({ ok: true, id: rows[0] ? rows[0].id : null, push_ready: pushReady() });
  }
  if (action === 'push_unsubscribe') {
    const endpoint = String(b.endpoint || ''); const id = Number(b.id);
    if (!endpoint && !Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'Which device?' });
    const q = endpoint ? `endpoint=eq.${enc(endpoint)}` : `id=eq.${id}`;
    await fetch(`${s.base}/rest/v1/push_subscriptions?${q}&agent_email=eq.${enc(me.email)}`, { method: 'DELETE', headers: s.hdrs });   /* only their own */
    await record(s, { actor: me.email, kind: 'chat.push_off', source: 'chat', client_no: null, payload: {} });
    return res.status(200).json({ ok: true });
  }
  if (action === 'mute') {
    /* '1h' | 'tomorrow' (8 AM Pacific) | 'off' */
    const kind = String(b.until || 'off');
    let until = null;
    if (kind === '1h') until = new Date(Date.now() + 3600 * 1000).toISOString();
    else if (kind === 'tomorrow') { const d = new Date(Date.now() - 7 * 3600 * 1000); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(8, 0, 0, 0); until = new Date(d.getTime() + 7 * 3600 * 1000).toISOString(); }
    else if (kind !== 'off') return res.status(400).json({ ok: false, error: 'Bad mute' });
    await fetch(`${s.base}/rest/v1/agent_duty`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ agent_email: me.email, muted_until: until, updated_at: now }]) });
    await record(s, { actor: me.email, kind: until ? 'chat.muted' : 'chat.unmuted', source: 'chat', client_no: null, payload: { until } });
    return res.status(200).json({ ok: true, muted_until: until });
  }
  if (action === 'sms_alerts') {
    const on = b.on !== false;
    await fetch(`${s.base}/rest/v1/agent_duty`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ agent_email: me.email, sms_alerts: on, updated_at: now }]) });
    return res.status(200).json({ ok: true, sms_alerts: on });
  }

  if (action === 'set_setting') {
    if (!me.admin) return res.status(403).json({ ok: false, error: 'Admin only' });
    const ALLOWED = { claim_window_s: v => Number.isInteger(v) && v >= 15 && v <= 600, silent_agent_s: v => Number.isInteger(v) && v >= 30 && v <= 1800,
      escalation_phones: v => Array.isArray(v) && v.every(x => /^\+1\d{10}$/.test(x)) && v.length <= 5, closed_dates: v => Array.isArray(v) && v.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x)),
      blocked: v => v && typeof v === 'object' && Array.isArray(v.phones) && Array.isArray(v.ips) };
    const key = String(b.key || '');
    if (!ALLOWED[key] || !ALLOWED[key](b.value)) return res.status(400).json({ ok: false, error: 'Bad setting' });
    await fetch(`${s.base}/rest/v1/chat_settings`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key, value: b.value, updated_at: now, updated_by: me.email }]) });
    await record(s, { actor: me.email, kind: 'chat.setting', source: 'chat', client_no: null, payload: { key, value: b.value } });
    return res.status(200).json({ ok: true });
  }

  if (action === 'find_client') {
    const q = clean(b.q, 60); if (!q) return res.status(400).json({ ok: false, error: 'Type a name, phone or client number' });
    const results = await findClients(s, q, 8);
    return res.status(200).json({ ok: true, results });
  }

  /* ---- Stage 3 item 2 (Sep 18): a client's conversations for the Log tab. The Log READS
     the threads instead of copying texts into events, so it is current the moment a text
     arrives and there is one copy of the words. Rules:
       confirmed link + the caller may see the thread  -> the messages and photo indexes
       confirmed link, thread not visible (sms_private) -> the row and the counts only
       guess (phone match, not confirmed)              -> the fact that a matching number is
                                                          texting, no words: a wrong guess must
                                                          never put a stranger's texts on a client
     Test threads never show on a client. ---- */
  if (action === 'client_log') {
    const no = Number(b.client_no);
    if (!Number.isInteger(no) || no <= 0) return res.status(400).json({ ok: false, error: 'Bad client' });
    const cv = await sbGet(s, `conversations?client_no=eq.${no}&is_test=is.false&link_status=in.(confirmed,guess)&select=id,channel,line,status,outcome,branch,topic,lang,visitor_name,visitor_phone,link_status,policy,linked_by,linked_at,claimed_by,closed_by,closed_at,close_note,created_at,updated_at,visibility&order=created_at.desc&limit=20`);
    const priv = await privateLines(s);
    const convs = cv.rows.map(c => ({ ...c, visible: c.link_status === 'confirmed' && canSee(c, me, priv) }));
    const confirmedIds = convs.filter(c => c.link_status === 'confirmed').map(c => c.id);
    const ms = confirmedIds.length ? await sbGet(s, `messages?conversation_id=in.(${confirmedIds.join(',')})&audience=eq.visitor&sender_kind=in.(visitor,agent)&select=id,conversation_id,ts,sender_kind,sender,body,attachments&order=id.asc&limit=1500`) : { rows: [] };
    const lines = [...new Set(convs.map(c => c.line).filter(Boolean))];
    const ln = lines.length ? await sbGet(s, `rc_numbers?phone10=in.(${lines.join(',')})&select=phone10,agent_email,usage_type,branch`) : { rows: [] };
    const emails = new Set();
    for (const c of convs) for (const e of [c.linked_by, c.claimed_by, c.closed_by]) if (e && e.includes('@')) emails.add(e);
    for (const m of ms.rows) if (m.sender) emails.add(m.sender);
    for (const l of ln.rows) if (l.agent_email) emails.add(l.agent_email);
    const names = {};
    if (emails.size) { const a = await sbGet(s, `agents?email=in.(${[...emails].map(enc).join(',')})&select=email,full_name`); for (const r of a.rows) names[r.email] = r.full_name || r.email; }
    const nm = e => e ? (names[e] || (e.includes('@') ? e.split('@')[0] : e)) : null;
    const lineLabel = c => {
      if (c.channel !== 'sms' || !c.line) return null;
      const l = ln.rows.find(x => x.phone10 === c.line);
      if (l && l.agent_email) return `${String(nm(l.agent_email)).split(' ')[0]}’s line`;
      return `the ${BRANCHES[(l && l.branch) || c.branch] || 'branch'} line`;
    };
    const out = convs.map(c => {
      const mine = ms.rows.filter(m => m.conversation_id === c.id);
      const photosOf = m => (Array.isArray(m.attachments) ? m.attachments : []).map((a, index) => ({ a, index })).filter(x => x.a && x.a.ok && /^image\//.test(String(x.a.content_type || ''))).map(x => ({ index: x.index, content_type: x.a.content_type }));
      const counts = { messages: mine.length, photos: mine.reduce((n, m) => n + photosOf(m).length, 0) };
      return {
        id: c.id, channel: c.channel, status: c.status, outcome: c.outcome, branch: c.branch, branch_name: BRANCHES[c.branch] || c.branch || null, topic: c.topic, lang: c.lang,
        name: c.visitor_name, phone: c.visitor_phone, link_status: c.link_status, policy: c.policy || null,
        linked_by: nm(c.linked_by), linked_at: c.linked_at, claimed_by: nm(c.claimed_by), closed_by: c.closed_by === 'visitor' ? 'visitor' : nm(c.closed_by), closed_at: c.closed_at, close_note: c.close_note || null,
        created_at: c.created_at, updated_at: c.updated_at, line: c.line, line_label: lineLabel(c), visible: c.visible,
        counts: c.link_status === 'confirmed' ? counts : null,
        messages: c.visible ? mine.map(m => ({ id: m.id, ts: m.ts, from: m.sender_kind, name: m.sender_kind === 'agent' ? String(nm(m.sender)).split(' ')[0] : null, body: m.body, photos: photosOf(m) })) : [],
      };
    });
    return res.status(200).json({ ok: true, client_no: no, conversations: out });
  }

  /* everything below is about one conversation */
  const id = Number(b.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'Bad id' });
  const cv = await sbGet(s, `conversations?id=eq.${id}&select=*&limit=1`);
  const conv = cv.rows[0];
  if (!conv) return res.status(404).json({ ok: false, error: 'No such chat' });

  if (action === 'thread') {
    if (conv.visibility === 'owner' && !canSee(conv, me, await privateLines(s))) return res.status(403).json({ ok: false, error: 'Not your thread' });
    const [ms, prev, card] = await Promise.all([
      sbGet(s, `messages?conversation_id=eq.${id}&select=id,ts,sender_kind,sender,audience,channel,body,sms_from,attachments&order=id.asc&limit=500`),
      conv.visitor_phone ? sbGet(s, `conversations?visitor_phone=eq.${conv.visitor_phone}&id=neq.${id}&select=id,created_at,status,outcome,topic,claimed_by,lead_id&order=id.desc&limit=5`) : { rows: [] },
      clientCard(s, conv),
    ]);
    if (conv.claimed_by === me.email) await sbPatch(s, `conversations?id=eq.${id}`, { agent_seen_at: now });
    const names = {}; const emails = [...new Set(ms.rows.map(m => m.sender).filter(Boolean).concat(conv.claimed_by ? [conv.claimed_by] : []))];
    if (emails.length) { const a = await sbGet(s, `agents?email=in.(${emails.map(enc).join(',')})&select=email,full_name`); for (const r of a.rows) names[r.email] = String(r.full_name || r.email).split(' ')[0]; }
    return res.status(200).json({ ok: true,
      conversation: { ...conv, token: undefined, branch_name: BRANCHES[conv.branch] || conv.branch, claimed_name: names[conv.claimed_by] || null, visitor_here: !!conv.visitor_seen_at && (Date.now() - new Date(conv.visitor_seen_at).getTime()) < VISITOR_GONE_MS, mine: conv.claimed_by === me.email },
      messages: ms.rows.map(m => ({ ...m, name: m.sender ? (names[m.sender] || m.sender) : null })),
      previous: prev.rows, client: card, me: { email: me.email, admin: me.admin, sees_all: me.sees_all, first: me.first },
    });
  }

  /* one attachment, as base64, after the same visibility check as the thread (the
     bucket is private; the file only ever travels through this authenticated call) */
  if (action === 'media') {
    if (conv.visibility === 'owner' && !canSee(conv, me, await privateLines(s))) return res.status(403).json({ ok: false, error: 'Not your thread' });
    const mid = Number(b.message_id), idx = Number(b.index);
    const mm = await sbGet(s, `messages?id=eq.${mid}&conversation_id=eq.${id}&select=attachments&limit=1`);
    const att = mm.rows[0] && Array.isArray(mm.rows[0].attachments) ? mm.rows[0].attachments[idx] : null;
    if (!att) return res.status(404).json({ ok: false, error: 'No such attachment' });
    if (!att.ok || !att.path) return res.status(409).json({ ok: false, error: 'Not stored yet' + (att.error ? ': ' + att.error : ''), pending: true });
    const f = await fetch(`${s.base}/storage/v1/object/chat-media/${att.path}`, { headers: { apikey: s.hdrs.apikey, Authorization: s.hdrs.Authorization } });
    if (f.status !== 200) return res.status(502).json({ ok: false, error: 'Storage read failed' });
    const buf = Buffer.from(await f.arrayBuffer());
    return res.status(200).json({ ok: true, content_type: att.content_type || 'application/octet-stream', size: buf.length, data: buf.toString('base64') });
  }

  if (action === 'claim') {
    /* atomic: only a waiting, unclaimed row flips; two taps, one winner */
    const r = await sbPatch(s, `conversations?id=eq.${id}&status=eq.waiting&claimed_by=is.null`, { claimed_by: me.email, claimed_at: now, status: 'active', agent_seen_at: now, updated_at: now });
    if (!r.rows.length) {
      const fresh = await sbGet(s, `conversations?id=eq.${id}&select=claimed_by,status&limit=1`);
      const f = fresh.rows[0] || {};
      const n = f.claimed_by ? await sbGet(s, `agents?email=eq.${enc(f.claimed_by)}&select=full_name&limit=1`) : { rows: [] };
      return res.status(409).json({ ok: false, error: f.claimed_by ? `${(n.rows[0] && n.rows[0].full_name) || f.claimed_by} got it` : `Chat is ${f.status}`, taken_by: f.claimed_by || null, status: f.status });
    }
    await sysMsg(s, conv, conv.lang === 'es' ? `${me.first} se unió al chat` : `${me.first} joined the chat`);
    await record(s, { actor: me.email, kind: 'chat.claimed', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, waited_s: secs(conv.created_at, now), alerts: (conv.alerts || []).length, is_test: conv.is_test } });
    await withdrawAlerts(s, conv, me.email);
    return res.status(200).json({ ok: true, claimed_by: me.email });
  }

  if (action === 'takeover') {
    if (!me.admin) return res.status(403).json({ ok: false, error: 'Admin only' });
    if (conv.status === 'closed') return res.status(409).json({ ok: false, error: 'Chat is closed' });
    await sbPatch(s, `conversations?id=eq.${id}`, { claimed_by: me.email, claimed_at: conv.claimed_at || now, status: 'active', agent_seen_at: now, updated_at: now });
    await sysMsg(s, conv, `${me.first} took over from ${conv.claimed_by || 'the queue'}`, 'agents');
    if (conv.status === 'waiting') await withdrawAlerts(s, conv, me.email);
    await sysMsg(s, conv, conv.lang === 'es' ? `${me.first} se unió al chat` : `${me.first} joined the chat`);
    await record(s, { actor: me.email, kind: 'chat.takeover', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, from: conv.claimed_by, is_test: conv.is_test } });
    return res.status(200).json({ ok: true });
  }

  const whisperOnly = action === 'reply' && b.whisper === true && me.sees_all;
  if (!canAct(conv, me) && !whisperOnly) return res.status(403).json({ ok: false, error: 'Not your chat' });

  /* ---- the client link (Sep 17): a phone match is a GUESS until an agent says so ---- */
  if (action === 'link') {
    const client_no = Number(b.client_no);
    if (!Number.isInteger(client_no) || client_no <= 0) return res.status(400).json({ ok: false, error: 'Bad client number' });
    const c = await sbGet(s, `clients?client_no=eq.${client_no}&select=client_no&limit=1`);
    if (!c.rows[0]) return res.status(404).json({ ok: false, error: 'No such client' });
    const patch = { client_no, link_status: 'confirmed', linked_by: me.email, linked_at: now, updated_at: now };
    if (conv.visitor_phone) {
      /* the agent's decision, remembered for this phone: wins over the HawkSoft guess next time */
      await fetch(`${s.base}/rest/v1/phone_links?phone10=eq.${conv.visitor_phone}&kind=eq.link`, { method: 'DELETE', headers: s.hdrs });
      await fetch(`${s.base}/rest/v1/phone_links`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ phone10: conv.visitor_phone, client_no, kind: 'link', by_email: me.email, at: now }]) });
    }
    if (b.policy && typeof b.policy === 'object') patch.policy = cleanPolicy(b.policy);
    await sbPatch(s, `conversations?id=eq.${id}`, patch);
    await record(s, { actor: me.email, kind: 'chat.linked', source: 'chat', client_no, payload: { conversation_id: id, phone: conv.visitor_phone, was: conv.client_no || null, how: conv.client_no === client_no ? 'confirmed' : 'chosen', policy: patch.policy || null, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, client_no, link_status: 'confirmed', policy: patch.policy || conv.policy || null });
  }
  if (action === 'unlink') {
    if (!conv.client_no) return res.status(409).json({ ok: false, error: 'Nothing linked' });
    if (conv.visitor_phone) {
      await fetch(`${s.base}/rest/v1/phone_links?phone10=eq.${conv.visitor_phone}&client_no=eq.${conv.client_no}`, { method: 'DELETE', headers: s.hdrs });
      await fetch(`${s.base}/rest/v1/phone_links`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ phone10: conv.visitor_phone, client_no: conv.client_no, kind: 'reject', by_email: me.email, at: now }]) });
    }
    await sbPatch(s, `conversations?id=eq.${id}`, { client_no: null, link_status: 'none', policy: null, linked_by: me.email, linked_at: now, updated_at: now });
    await record(s, { actor: me.email, kind: 'chat.unlinked', source: 'chat', client_no: conv.client_no, payload: { conversation_id: id, phone: conv.visitor_phone, rejected: conv.client_no, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, client_no: null, link_status: 'none' });
  }
  if (action === 'set_policy') {
    if (!conv.client_no) return res.status(409).json({ ok: false, error: 'Link a client first' });
    const policy = cleanPolicy(b.policy);
    if (!policy) return res.status(400).json({ ok: false, error: 'Bad policy' });
    await sbPatch(s, `conversations?id=eq.${id}`, { policy, updated_at: now });
    await record(s, { actor: me.email, kind: 'chat.policy', source: 'chat', client_no: conv.client_no, payload: { conversation_id: id, policy, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, policy });
  }

  if (action === 'unclaim') {
    if (conv.status !== 'active') return res.status(409).json({ ok: false, error: 'Not active' });
    await sbPatch(s, `conversations?id=eq.${id}`, { claimed_by: null, claimed_at: null, status: 'waiting', updated_at: now });
    await sysMsg(s, conv, `${me.first} put the chat back in the queue`, 'agents');
    await record(s, { actor: me.email, kind: 'chat.unclaimed', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, is_test: conv.is_test } });
    return res.status(200).json({ ok: true });
  }

  if (action === 'reply') {
    const body = clean(b.body, 2000);
    if (!body) return res.status(400).json({ ok: false, error: 'Empty message' });
    if (conv.status === 'closed') return res.status(409).json({ ok: false, error: 'Chat is closed' });
    const whisper = b.whisper === true;
    if (whisper && !me.sees_all) return res.status(403).json({ ok: false, error: 'Only an admin can whisper' });
    /* Sep 17: Tony (admin) answered before claiming and the visitor got a reply from
       nobody, then "Tony joined". A visitor-facing reply on an unclaimed chat claims it
       first, atomically; if someone else just won, the reply is refused with their name. */
    if (!whisper && conv.status === 'waiting' && !conv.claimed_by) {
      const r = await sbPatch(s, `conversations?id=eq.${id}&status=eq.waiting&claimed_by=is.null`, { claimed_by: me.email, claimed_at: now, status: 'active', agent_seen_at: now, updated_at: now });
      if (!r.rows.length) {
        const fresh = await sbGet(s, `conversations?id=eq.${id}&select=claimed_by&limit=1`);
        const n = fresh.rows[0] && fresh.rows[0].claimed_by ? await sbGet(s, `agents?email=eq.${enc(fresh.rows[0].claimed_by)}&select=full_name&limit=1`) : { rows: [] };
        return res.status(409).json({ ok: false, error: `${(n.rows[0] && n.rows[0].full_name) || 'Another agent'} got it` });
      }
      await sysMsg(s, conv, conv.lang === 'es' ? `${me.first} se unió al chat` : `${me.first} joined the chat`);
      await record(s, { actor: me.email, kind: 'chat.claimed', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, waited_s: secs(conv.created_at, now), alerts: (conv.alerts || []).length, by_reply: true, is_test: conv.is_test } });
      conv.claimed_by = me.email; conv.status = 'active';
      await withdrawAlerts(s, conv, me.email);
    }
    /* the visitor left the page and gave a phone: the reply goes out as a text too */
    let via = 'web', rc_message_id = null, sms_from = null;
    const gone = !conv.visitor_seen_at || (Date.now() - new Date(conv.visitor_seen_at).getTime()) > VISITOR_GONE_MS;
    let lastByText = false;
    if (!whisper && conv.channel !== 'sms' && !gone && conv.visitor_phone) { const lv = await sbGet(s, `messages?conversation_id=eq.${id}&sender_kind=eq.visitor&select=channel&order=id.desc&limit=1`); lastByText = !!(lv.rows[0] && lv.rows[0].channel === 'sms'); }
    if (!whisper && conv.visitor_phone && (conv.channel === 'sms' || gone || lastByText)) {
      /* from the thread's own line (the branch number, or the agent's direct number it came in on) */
      /* a text thread: introduce the agent on the FIRST text and whenever a different agent
         starts writing; every other text goes out clean (Saif, Sep 17) */
      let text;
      if (conv.channel === 'sms') {
        const last = await sbGet(s, `messages?conversation_id=eq.${id}&sender_kind=eq.agent&audience=eq.visitor&select=sender&order=id.desc&limit=1`);
        const introduce = !last.rows[0] || last.rows[0].sender !== me.email;
        text = introduce ? `Speedy Insurance (${me.first}): ${body}` : body;
      } else text = `Speedy Insurance (${me.first}): ${body} — reply by text or call (951) 695-1500`;
      const r = conv.is_test ? { ok: true, skipped: true } : await smsSend('+1' + conv.visitor_phone, text, conv.line || null);
      if (r && r.ok) { via = 'sms'; rc_message_id = r.id ? String(r.id) : null; sms_from = r.from ? String(r.from).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null; }
      else if (conv.channel === 'sms') return res.status(502).json({ ok: false, error: 'The text could not be sent' + (r && r.error ? ': ' + r.error : '') });
    }
    const m = await sbPost(s, 'messages', { conversation_id: id, sender_kind: 'agent', sender: me.email, audience: whisper ? 'agents' : 'visitor', channel: via, body, rc_message_id, sms_from, is_test: conv.is_test });
    if (!m.ok) return res.status(502).json({ ok: false, error: 'Could not send' });
    if (whisper && conv.claimed_by && conv.claimed_by !== me.email) await pushOwner(s, conv, 'whisper', `${me.first} whispered on your chat with ${who(conv)}`, body);
    const patch = { agent_seen_at: now, updated_at: now }; if (!whisper && !conv.first_reply_at) patch.first_reply_at = now;
    await sbPatch(s, `conversations?id=eq.${id}`, patch);
    if (!whisper && !conv.first_reply_at) await record(s, { actor: me.email, kind: 'chat.first_reply', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, seconds: secs(conv.created_at, now), via, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, id: m.row.id, via, sms_from });
  }

  if (action === 'handoff') {
    const to = String(b.to || '').toLowerCase();
    const a = await sbGet(s, `agents?email=eq.${enc(to)}&active=is.true&select=email,full_name&limit=1`);
    if (!a.rows[0]) return res.status(400).json({ ok: false, error: 'No such agent' });
    const first = String(a.rows[0].full_name || to).split(' ')[0];
    await sbPatch(s, `conversations?id=eq.${id}`, { claimed_by: to, claimed_at: now, status: 'active', updated_at: now });
    await sysMsg(s, conv, `${me.first} handed the chat to ${first}`, 'agents');
    await sysMsg(s, conv, conv.lang === 'es' ? `${first} se unió al chat` : `${first} joined the chat`);
    await record(s, { actor: me.email, kind: 'chat.handoff', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, to, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, to });
  }

  if (action === 'close') {
    const outcome = String(b.outcome || '');
    if (!['lead', 'logged', 'spam', 'abandoned'].includes(outcome)) return res.status(400).json({ ok: false, error: 'Bad outcome' });
    if (conv.status === 'closed') return res.status(409).json({ ok: false, error: 'Already closed' });
    const note = clean(b.note, 1000);
    const patch = { status: 'closed', outcome, closed_at: now, closed_by: me.email, close_note: note || null, updated_at: now };
    if (outcome === 'lead') {
      if (!conv.visitor_phone && !conv.visitor_email) return res.status(400).json({ ok: false, error: 'A phone or email is needed to make a lead', code: 'need_phone' });
      const lead_id = conv.lead_id || await convertToLead(s, conv, { message: note });
      if (!lead_id) return res.status(502).json({ ok: false, error: 'Could not create the lead' });
      patch.lead_id = lead_id;
    }
    if (outcome === 'logged') {
      if (!conv.client_no) return res.status(400).json({ ok: false, error: 'No client matched - close as a lead instead', code: 'no_client' });
      const msgs = await sbGet(s, `messages?conversation_id=eq.${id}&audience=eq.visitor&select=sender_kind,sender,body&order=id.asc&limit=200`);
      const transcript = msgs.rows.map(m => `${m.sender_kind === 'visitor' ? 'Client' : (m.sender_kind === 'agent' ? me.first : 'Speedy')}: ${m.body}`).join('\n').slice(0, 6000);
      await record(s, { actor: me.email, kind: 'chat.logged', source: 'chat', client_no: conv.client_no, payload: { conversation_id: id, transcript, note, branch: conv.branch, topic: conv.topic, is_test: conv.is_test } });
    }
    if (outcome === 'spam' && me.admin && b.block === true && (conv.visitor_phone || conv.ip)) {
      const blocked = cfg.blocked && typeof cfg.blocked === 'object' ? cfg.blocked : { phones: [], ips: [] };
      if (conv.visitor_phone && !blocked.phones.includes(conv.visitor_phone)) blocked.phones.push(conv.visitor_phone);
      if (conv.ip && !blocked.ips.includes(conv.ip)) blocked.ips.push(conv.ip);
      await fetch(`${s.base}/rest/v1/chat_settings`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: 'blocked', value: blocked, updated_at: now, updated_by: me.email }]) });
    }
    await sbPatch(s, `conversations?id=eq.${id}`, patch);
    if (conv.channel !== 'sms') await sysMsg(s, conv, conv.lang === 'es' ? 'El chat terminó. Gracias.' : 'This chat has ended. Thank you.');   /* a text thread ends quietly */
    await record(s, { actor: me.email, kind: 'chat.closed', source: 'chat', client_no: conv.client_no || null, payload: { conversation_id: id, outcome, lead_id: patch.lead_id || null, duration_s: secs(conv.created_at, now), first_reply_s: conv.first_reply_at ? secs(conv.created_at, conv.first_reply_at) : null, is_test: conv.is_test } });
    return res.status(200).json({ ok: true, outcome, lead_id: patch.lead_id || null });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
