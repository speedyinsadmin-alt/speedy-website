/* ---------------------------------------------------------------------------
   api/rc-sms.js — RingCentral SMS events -> the Inbox. Sep 17 2026.

   Its OWN webhook and subscription, separate from rc-webhook.js (telephony), so
   nothing here can take the call log down. Same gate: ?token=<RC_WEBHOOK_TOKEN>,
   same Validation-Token handshake, always 200 to RingCentral.

   One event = one SMS (message-store/instant). Two kinds:
     Inbound   customer -> one of OUR numbers (a branch line or an agent's direct number)
     Outbound  an agent texted the customer from the RingCentral app (mirrored, read-only)

   What happens to it:
     - deduped on the RingCentral message id (unique index; a 409 means "seen")
     - threaded onto the customer's OPEN conversation (web chat or sms), else a new
       conversation with channel=sms, line=our number, branch from the number
     - a branch line -> visibility all, status waiting (the queue, the alert chain)
       an agent's direct number -> visibility owner, claimed by that agent, active,
       NO alerts (they already get it in the RingCentral app - mirror, not takeover)
     - client matched by phone; events sms.in / sms.out carry client_no so the
       texts show on the client's Log tab
   Nothing here sends. Nothing here logs message bodies.
--------------------------------------------------------------------------- */
import { randomBytes } from 'node:crypto';
import { resolveClient, branchCode } from './_inbox.js';

/* ---- RingCentral auth (JWT -> access token), the proven flow from sms.js, for
   downloading MMS media. Media is the whole point of many texts (licence, DMV
   letter, dec page), so a text with photos is stored WITH its photos. ---- */
const RC_BASE = () => (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
let rcTok = { value: null, expires: 0 };
async function rcToken() {
  if (rcTok.value && Date.now() < rcTok.expires) return rcTok.value;
  const basic = Buffer.from(`${process.env.RC_CLIENT_ID}:${process.env.RC_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${RC_BASE()}/restapi/oauth/token`, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: process.env.RC_JWT }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`auth HTTP ${r.status}: ${j.error_description || j.error || ''}`);
  rcTok = { value: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return rcTok.value;
}
const MEDIA_BUCKET = 'chat-media';
const extOf = ct => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3', 'text/vcard': 'vcf' }[String(ct || '').toLowerCase().split(';')[0]] || 'bin');
/* download one RingCentral attachment and put it in the private bucket; never throws */
export async function storeMedia(s, att, convId, rcMsgId) {
  const out = { id: String(att.id), content_type: att.contentType || null, size: null, path: null, ok: false, error: null };
  try {
    const tok = await rcToken();
    const uri = String(att.uri || '');
    if (!/^https:\/\/[a-z0-9.-]+\.ringcentral\.com\//i.test(uri)) throw new Error('unexpected media host');
    const r = await fetch(uri, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`RC media HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25 * 1024 * 1024) throw new Error('over 25 MB');
    const ct = r.headers.get('content-type') || att.contentType || 'application/octet-stream';
    out.content_type = ct.split(';')[0]; out.size = buf.length;
    const path = `sms/${convId}/${rcMsgId}-${att.id}.${extOf(out.content_type)}`;
    const up = await fetch(`${s.base}/storage/v1/object/${MEDIA_BUCKET}/${path}`, { method: 'POST', headers: { apikey: s.hdrs.apikey, Authorization: s.hdrs.Authorization, 'Content-Type': out.content_type, 'x-upsert': 'true' }, body: buf });
    if (!up.ok) throw new Error(`storage HTTP ${up.status}`);
    out.path = path; out.ok = true;
  } catch (e) { out.error = String(e.message || e).slice(0, 200); out.uri = att.uri || null; }
  return out;
}

const BRANCHES = { mv: 'Moreno Valley', vb: 'Riverside — Van Buren', mg: 'Riverside — Magnolia', le: 'Lake Elsinore', co: 'Colton' };

const sb = () => {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
};
async function sbGet(s, path) { const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs }); const rows = await r.json().catch(() => null); return { ok: r.ok, rows: Array.isArray(rows) ? rows : [] }; }
async function sbPost(s, table, row) {
  const r = await fetch(`${s.base}/rest/v1/${table}`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' }, body: JSON.stringify([row]) });
  const rows = await r.json().catch(() => null);
  return { ok: r.ok && Array.isArray(rows) && !!rows[0], status: r.status, row: Array.isArray(rows) ? rows[0] : null };
}
async function sbPatch(s, path, obj) { const r = await fetch(`${s.base}/rest/v1/${path}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify(obj) }); return r.ok; }
async function record(s, row) { try { await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); } catch { /* audit must not fail ingest */ } }

const digits10 = v => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : (d.length === 10 ? d : null); };
const enc = encodeURIComponent;

/* the message as RingCentral sends it inside the event body */
export function shape(payload) {
  const b = payload && payload.body; if (!b || !b.id) return null;
  const type = String(b.type || '').toUpperCase(); if (type !== 'SMS' && type !== 'MMS') return null;
  const direction = String(b.direction || '').toLowerCase();
  const from = digits10(b.from && b.from.phoneNumber);
  const tos = (Array.isArray(b.to) ? b.to : []).map(t => digits10(t && t.phoneNumber)).filter(Boolean);
  const text = String(b.subject || '').trim();
  const extensionId = String((b.extensionId != null ? b.extensionId : (payload.event || '').match(/extension\/(\d+)/)?.[1]) || '') || null;
  /* RingCentral lists the text itself as an attachment of type Text; media is the rest */
  const media = (Array.isArray(b.attachments) ? b.attachments : []).filter(a => a && a.id && String(a.type || '') !== 'Text' && !/^text\/plain/i.test(String(a.contentType || '')));
  return { rc_id: String(b.id), direction, from, tos, text, ts: b.creationTime || new Date().toISOString(), extensionId, attachments: media.length, media };
}

export async function ingest(s, m) {
  if (!m) return { skipped: 'not an sms' };
  /* which side is ours */
  const cand = m.direction === 'inbound' ? m.tos : [m.from];
  const nums = cand.length ? await sbGet(s, `rc_numbers?phone10=in.(${cand.join(',')})&select=phone10,extension_id,usage_type,branch,agent_email,extension_name`) : { rows: [] };
  let line = nums.rows[0];
  if (!line && m.extensionId) { const byExt = await sbGet(s, `rc_numbers?extension_id=eq.${enc(m.extensionId)}&sms=is.true&select=phone10,extension_id,usage_type,branch,agent_email,extension_name&limit=1`); line = byExt.rows[0]; }
  const customer = m.direction === 'inbound' ? m.from : m.tos.find(t => !nums.rows.some(n => n.phone10 === t)) || m.tos[0];
  if (!customer) return { skipped: 'no customer number' };
  if (!line) return { skipped: 'not one of our numbers', customer_present: true };
  if (line.phone10 === customer) return { skipped: 'self' };

  const body = m.text || (m.attachments ? `[${m.attachments} ${m.attachments === 1 ? 'photo/file' : 'photos/files'}]` : '');
  if (!body) return { skipped: 'empty' };

  /* the customer's open thread, if any: newest first, prefer one on this line */
  const open = await sbGet(s, `conversations?visitor_phone=eq.${customer}&status=in.(waiting,active)&select=id,channel,line,status,claimed_by,client_no,link_status,visibility,lang,is_test&order=id.desc&limit=5`);
  let conv = open.rows.find(c => c.line === line.phone10) || open.rows[0] || null;
  const now = new Date().toISOString();
  const mirror = line.usage_type === 'DirectNumber' && !!line.agent_email;   /* an agent's own number */

  let client_no = conv ? conv.client_no : null, link_status = conv ? (conv.link_status || 'none') : 'none';
  if (!client_no) { const rc = await resolveClient(s, customer); client_no = rc.client_no; link_status = rc.status; }

  let created = false;
  if (!conv) {
    /* the thread's branch decides which agents see a mirror thread (chat.js canSee):
       the number's branch if set on the numbers table, else its owner's home branch */
    let branch = line.branch || null;
    if (!branch && mirror) { const ag = await sbGet(s, `agents?email=eq.${enc(line.agent_email)}&select=branch&limit=1`); branch = branchCode(ag.rows[0] && ag.rows[0].branch); }
    const prev = await sbGet(s, `conversations?visitor_phone=eq.${customer}&select=id,visitor_name&order=id.desc&limit=1`);
    const r = await sbPost(s, 'conversations', {
      channel: 'sms', token: cryptoToken(), source_page: null, lang: 'en', branch, topic: null,
      visitor_name: prev.rows[0] ? prev.rows[0].visitor_name : null, visitor_phone: customer, client_no, link_status, previous_id: prev.rows[0] ? prev.rows[0].id : null,
      line: line.phone10, line_extension_id: line.extension_id || null, visibility: mirror ? 'owner' : 'all',
      status: mirror ? 'active' : (m.direction === 'inbound' ? 'waiting' : 'active'),
      claimed_by: mirror ? line.agent_email : null, claimed_at: mirror ? now : null,
      visitor_seen_at: m.direction === 'inbound' ? now : null, is_test: false,
    });
    if (!r.ok) return { error: 'could not create conversation' };
    conv = r.row; created = true;
  }

  /* the message itself; a duplicate delivery hits the unique index and is skipped */
  const msg = await sbPost(s, 'messages', {
    conversation_id: conv.id, sender_kind: m.direction === 'inbound' ? 'visitor' : 'agent',
    sender: m.direction === 'inbound' ? null : (line.agent_email || null), audience: 'visitor', channel: 'sms', body, rc_message_id: m.rc_id, is_test: conv.is_test === true,
  });
  if (!msg.ok) { if (msg.status === 409) return { skipped: 'duplicate', conversation_id: conv.id }; return { error: 'could not write message' }; }
  /* the media, after the row exists: a failed download is recorded on the row (ok:false + uri) for the backfill, never lost silently */
  let stored = 0;
  if (m.media && m.media.length) {
    const atts = [];
    for (const a of m.media.slice(0, 10)) { const r = await storeMedia(s, a, conv.id, m.rc_id); atts.push(r); if (r.ok) stored++; }
    await sbPatch(s, `messages?id=eq.${msg.row.id}`, { attachments: atts });
  }

  const patch = { updated_at: now, line: conv.line || line.phone10, line_extension_id: conv.line_extension_id || line.extension_id || null };
  if (m.direction === 'inbound') { patch.visitor_seen_at = now; if (!conv.client_no && client_no) { patch.client_no = client_no; patch.link_status = link_status; } }
  else {
    patch.agent_seen_at = now;
    /* an agent answered from the RingCentral app: that is their thread now */
    if (!conv.claimed_by && line.agent_email) { patch.claimed_by = line.agent_email; patch.claimed_at = now; patch.status = 'active'; }
    else if (conv.status === 'waiting' && !line.agent_email) { /* answered from a branch line by someone we cannot name: leave it waiting for a claim */ }
  }
  await sbPatch(s, `conversations?id=eq.${conv.id}`, patch);
  await record(s, { actor: m.direction === 'inbound' ? 'customer' : (line.agent_email || 'ringcentral'), kind: m.direction === 'inbound' ? 'sms.in' : 'sms.out', source: 'ringcentral', client_no: client_no || null,
    payload: { conversation_id: conv.id, line: line.phone10, branch: line.branch || null, mirror, created, chars: body.length, rc_message_id: m.rc_id, media: m.attachments || 0, stored } });
  return { ok: true, conversation_id: conv.id, created, mirror, direction: m.direction, client_no: client_no || null, media: m.attachments || 0, stored };
}

const cryptoToken = () => randomBytes(16).toString('hex');

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const validation = req.headers['validation-token'];
  if (validation) { res.setHeader('Validation-Token', validation); return res.status(200).send(''); }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const expected = process.env.RC_WEBHOOK_TOKEN;
  const supplied = String((req.query && req.query.token) || '');
  if (!expected || supplied !== expected) return res.status(401).json({ ok: false, error: 'Invalid or missing token' });

  let payload = req.body; if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
  const s = sb();
  if (!s) return res.status(200).json({ ok: false, error: 'storage not configured' });
  try {
    const out = await ingest(s, shape(payload));
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('[rc-sms] ingest failed:', e.message);
    return res.status(200).json({ ok: false, error: 'ingest failed' });   /* 200 on purpose: keep the subscription alive */
  }
}
