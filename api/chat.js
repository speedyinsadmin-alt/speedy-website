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
    let client_no = null;
    if (phone) { const m = await sbGet(s, `client_phone_index?phone10=eq.${phone}&select=client_number&limit=1`); client_no = m.rows[0] ? m.rows[0].client_number : null; }
    /* the same person's last thread, so the agent sees history */
    let previous_id = null;
    if (phone) { const p = await sbGet(s, `conversations?visitor_phone=eq.${phone}&select=id&order=id.desc&limit=1`); previous_id = p.rows[0] ? p.rows[0].id : null; }

    const token = randomBytes(16).toString('hex');
    const conv = await sbPost(s, 'conversations', {
      channel: 'web', token, source_page: clean(b.page, 200), lang, branch, topic: clean(b.topic, 60),
      visitor_name: clean(b.name, 80), visitor_phone: phone, visitor_email: clean(b.email, 120), client_no, previous_id,
      status: mode === 'live' ? 'waiting' : 'offline', visitor_seen_at: new Date().toISOString(),
      ip: ip || null, ua: clean(req.headers['user-agent'], 300), is_test: b.is_test === true,
    });
    if (!conv.ok) return res.status(502).json({ ok: false, error: 'Could not start the chat - please call (951) 695-1500' });
    const greeting = GREET[lang](BRANCHES[branch]);
    await sbPost(s, 'messages', { conversation_id: conv.row.id, sender_kind: 'system', audience: 'visitor', channel: 'web', body: greeting, is_test: conv.row.is_test });
    if (clean(b.topic)) await sbPost(s, 'messages', { conversation_id: conv.row.id, sender_kind: 'visitor', audience: 'visitor', channel: 'web', body: clean(b.topic, 60), is_test: conv.row.is_test });
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
    return res.status(200).json({ ok: true, status: stale ? 'missed' : conv.status, agent, messages: ms.rows.map(m => ({ id: m.id, ts: m.ts, from: m.sender_kind, name: m.sender_kind === 'agent' ? (agent && agent.name) : null, body: m.body })) });
  }

  /* ------------------------------------------------ leave ------------------------------------------------ */
  if (action === 'leave') {
    if (conv.lead_id) return res.status(200).json({ ok: true, lead_id: conv.lead_id, already: true });
    const patch = { updated_at: new Date().toISOString() };
    const phone = digits10(b.phone); if (phone) patch.visitor_phone = phone;
    if (clean(b.name)) patch.visitor_name = clean(b.name, 80);
    if (clean(b.email)) patch.visitor_email = clean(b.email, 120);
    if (!(phone || conv.visitor_phone) && !(clean(b.email) || conv.visitor_email)) return res.status(400).json({ ok: false, error: 'A phone number or email is needed' });
    const message = clean(b.message, 2000);
    if (message) await sbPost(s, 'messages', { conversation_id: conv.id, sender_kind: 'visitor', audience: 'visitor', channel: 'web', body: message, is_test: conv.is_test });
    if (phone && !conv.client_no) { const m = await sbGet(s, `client_phone_index?phone10=eq.${phone}&select=client_number&limit=1`); if (m.rows[0]) patch.client_no = m.rows[0].client_number; }
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
