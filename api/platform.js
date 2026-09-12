export const config = { maxDuration: 300 };
import { randomUUID } from 'node:crypto';
// /api/platform — backend for the Platform Console (admin/platform.html).
// ACCESS: Google ID token (header x-id-token), allowlist below.
// GET  = reads (HawkSoft ZZTEST, our clients/policies/events, ledger, tables)
// POST = sync_zztest only: HawkSoft client 26081 -> our clients/policies + events. No other writes.

const GOOGLE_CLIENT_ID = '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const ADMIN_ALLOWLIST = ['info@speedyins.com'];
/* Producer code -> agent. Sourced from OUR clients table, so this keeps working
   after HawkSoft is retired. The producer is a record of who wrote the client and is
   NEVER rewritten by us — commission_to is a separate field we own. */
const PRODUCER_MAP = {
  SSM: 'sammy@speedyins.com',     JEV: 'jesus@speedyins.com',   THD: 'info@speedyins.com',
  AES: 'alejandra@speedyins.com', YVA: 'yasmin@speedyins.com',  LIF: 'lfigueroa@speedyins.com',
  JLR: 'jorge@speedyins.com',     CMA: 'chris@speedyins.com',   YYH: 'yolanda@speedyins.com',
  FSS: 'fernando@speedyins.com',  EHA: 'esmeralda@speedyins.com',
  MSH: 'melisa@speedyins.com',   MCR: 'malcolm@speedyins.com',
  IAH: 'irene@speedyins.com',    LND: 'lana@speedyins.com',
  GGR: 'gabriela@speedyins.com', DHT: 'daisy@speedyins.com',
};
const AGENT_NAME = {
  'sammy@speedyins.com':'Sammy Rodriguez','jesus@speedyins.com':'Jesus Velarde','info@speedyins.com':'Tony Dabouqi',
  'alejandra@speedyins.com':'Alejandra Salas','yasmin@speedyins.com':'Yasmin Alfaro','lfigueroa@speedyins.com':'Laura Figueroa',
  'jorge@speedyins.com':'Jorge Ramos','chris@speedyins.com':'Christian Aguilar','yolanda@speedyins.com':'Yolanda Hernandez',
  'fernando@speedyins.com':'Fernando Salgado','esmeralda@speedyins.com':'Esmeralda Ayala','irene@speedyins.com':'Irene Ayala',
  'tony@speedyins.com':'Tony Dabouqi','lana@speedyins.com':'Lana D',
  'melisa@speedyins.com':'Melisa Hernandez','malcolm@speedyins.com':'Malcolm Reese',
  'daisy@speedyins.com':'Daisy Hurtado',
  'gabriela@speedyins.com':'Gabriela Rosales',
};
const agentEmailOf = v => { const m = String(v || '').match(/[A-Za-z0-9._%+-]+@speedyins\.com/i); return m ? m[0].toLowerCase() : null; };
/* Move a payment to the correct client. Nothing is deleted: the original client number
   is preserved on the row and a correction note is written to BOTH HawkSoft records,
   because HawkSoft offers no way to remove what was posted in error. */
async function applyClientMove(s, row, toClient, actor, reason, wasApproved) {
  const fromClient = row.client_id;
  await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
    body: JSON.stringify({
      client_id: toClient,
      moved_from_client: row.moved_from_client != null ? row.moved_from_client : fromClient,
      correction_status: 'moved', correction_to_client: null,
      correction_decided_by: actor, correction_decided_at: new Date().toISOString(),
      correction_note: reason || row.correction_note || null,
    }) });

  // documents follow the payment
  await fetch(`${s.base}/rest/v1/attachments?payment_id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
    body: JSON.stringify({ client_no: toClient }) });

  // Correction notes straight to HawkSoft — this module already holds the credentials,
  // so no internal HTTP hop (which the other endpoint's auth would have rejected).
  const amt = Number(row.amount || 0).toFixed(2);
  const ref = row.txn_id || row.ref || '';
  const stampNow = new Date().toISOString();
  const postNote = async (clientNo, text) => {
    const r = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${clientNo}/log?version=4.0`, {
      method: 'POST',
      body: JSON.stringify({ refId: randomUUID(), ts: stampNow, channel: 32, note: text }),
    });
    return r.status === 200 || r.status === 202;
  };
  let notesOk = false;
  try {
    const a = await postNote(fromClient,
      `CORRECTION — the $${amt} payment logged on this record was posted to the wrong client in error and has been `
      + `moved to client #${toClient}. No refund and no re-charge; the card transaction is unchanged`
      + `${ref ? ' (Clover ' + ref + ')' : ''}. Corrected by ${actor}${reason ? ' — ' + reason : ''}.`);
    const b = await postNote(toClient,
      `CORRECTION — a $${amt} payment originally logged under client #${fromClient} in error belongs to this client and `
      + `has been moved here${ref ? ' (Clover ' + ref + ')' : ''}. Corrected by ${actor}${reason ? ' — ' + reason : ''}.`);
    notesOk = a && b;
  } catch { notesOk = false; }
  const notes = { ok: notesOk };

  await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
    body: JSON.stringify({ ts: new Date().toISOString(), actor, kind: 'client.corrected',
      client_no: toClient, source: 'platform',
      payload: { payment_id: row.id, amount: row.amount, from: fromClient, to: toClient,
                 reason, approved_by_owner: !!wasApproved, hawksoft_notes: !!notes.ok,
                 requested_by: row.correction_requested_by || actor,
                 owner: row.commission_to || agentEmailOf(row.agent) } }) });

  return { from: fromClient, to: toClient, hawksoft_notes: !!notes.ok };
}

/* ---------- Client notice on a refund ----------
   Saif, Sep 11: "I don't want any silent info" — every attempt to tell the client is
   recorded, whether it was sent, failed, or deliberately skipped, and the record says
   which address and who chose it. The same nodemailer/Gmail transport hawksoft.js has
   used for every charge confirmation since July; not a second mail path.
   Returns a plain result string in the SAME vocabulary the charge confirmation uses
   ("sent to …" / "failed: …" / "not configured"), so one reader can render both. */
async function sendRefundEmail(o) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return 'not configured';
  if (!o.to) return 'no address';
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    const amt = `$${Number(o.amount).toFixed(2)}`;
    const how = o.method === 'card'
      ? (o.voided ? 'The original charge has been cancelled before it settled, so it will simply drop off your statement rather than show as a separate refund.'
                  : 'It will show on the card used for the original payment, usually within 2 to 5 business days.')
      : 'This was returned to you in cash.';
    const html = `<table width="560" cellpadding="0" cellspacing="0" align="center" style="background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;width:100%">
      <tr><td style="padding:22px 28px 12px;text-align:center"><img src="https://www.speedyins.com/assets/logo.png" alt="Speedy Insurance Agency" width="160" style="max-width:160px;height:auto"></td></tr>
      <tr><td style="background:#0B1829;padding:12px 28px;text-align:center"><span style="color:#fff;font-size:18px;font-weight:bold">${o.voided ? 'Payment Cancelled' : 'Refund Issued'}</span></td></tr>
      <tr><td style="padding:22px 28px 6px">
        <p style="margin:0 0 14px;line-height:1.7;font-size:15px">Hi ${o.name || 'there'},</p>
        <p style="margin:0 0 16px;line-height:1.7;font-size:15px">We have ${o.voided ? 'cancelled' : 'refunded'} a payment on your account. ${how}</p>
        <table width="100%" cellpadding="9" cellspacing="0" style="border:1px solid #e0e0e0;font-size:14px;margin:0 0 18px">
          <tr style="background:#0B1829"><td colspan="2" style="color:#fff;font-weight:bold">${o.voided ? 'Cancellation' : 'Refund'} Details</td></tr>
          <tr><td style="color:#555;font-weight:bold;width:45%;border-bottom:1px solid #eee">Amount</td><td style="border-bottom:1px solid #eee"><b>${amt}</b></td></tr>
          <tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Original payment</td><td style="border-bottom:1px solid #eee">${o.original || ''}</td></tr>
          <tr><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Reason</td><td style="border-bottom:1px solid #eee">${o.reason || ''}</td></tr>
          ${o.confirmation ? `<tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Reference</td><td style="border-bottom:1px solid #eee">${o.confirmation}</td></tr>` : ''}
          <tr><td style="color:#555;font-weight:bold">Date</td><td>${o.stamp || ''} PT</td></tr>
        </table>
        <p style="margin:0 0 14px;line-height:1.6;font-size:12px;color:#888;font-style:italic">If you have a question about this, call us at (951) 472-0927 and mention the reference above.</p>
      </td></tr>
      <tr><td style="padding:0 28px 24px"><table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #D42B2B"><tr><td style="padding-top:12px;font-size:13px;line-height:1.8;color:#444"><strong>Speedy Insurance Agency</strong><br>(951) 472-0927 · speedyins.com</td></tr></table></td></tr></table>`;
    await t.sendMail({
      from: `"Speedy Insurance Agency" <${user}>`, to: o.to,
      subject: `${o.voided ? 'Payment cancelled' : 'Refund issued'} — ${amt} — Speedy Insurance Agency`,
      html,
      text: `${o.voided ? 'Payment cancelled' : 'Refund issued'}: ${amt}. ${how} Reason: ${o.reason || ''}. Speedy Insurance Agency, (951) 472-0927.`,
    });
    return `sent to ${o.to}`;
  } catch (e) { return `failed: ${String(e).slice(0, 80)}`; }
}

/* ONE shape for "was the client told", read off either a charge or a refund, so the
   card and the Audit tab render both the same way and neither can be blank.
     charge rows:  extra.confirmationEmail is a string from sendConfirmEmail
     refund rows:  extra.client_notice is the object written by refund_payment
   Returns { channel, to, source, result, detail, chosen_by, skip_reason } or null when
   the row predates any record at all — and null is rendered as "no record", which is
   itself information. */
function clientNoticeOf(row) {
  const x = row && row.extra;
  if (!x || typeof x !== 'object') return null;
  if (x.client_notice && typeof x.client_notice === 'object') return x.client_notice;
  const c = x.confirmationEmail;
  if (typeof c !== 'string') return null;
  if (c.startsWith('sent to ')) return { channel: 'email', to: c.slice(8), source: 'on_file', result: 'sent', detail: null };
  if (c === 'no client email on file') return { channel: 'none', to: null, source: null, result: 'skipped', detail: 'no email on file' };
  if (c === 'not configured') return { channel: 'email', to: null, source: null, result: 'failed', detail: 'email not configured' };
  if (c.startsWith('failed:')) return { channel: 'email', to: null, source: 'on_file', result: 'failed', detail: c.slice(7).trim() };
  return { channel: 'email', to: null, source: null, result: 'unknown', detail: c };
}

/* ---------- Partial payments (Tony's rule, Aug 2026) ----------
   Commission accrues in proportion to what the agency has actually COLLECTED, not to
   what the client owes. The carrier is paid in full at binding, so there is ONE audit
   and ONE fee for the whole obligation; commission is released as the money arrives.
   Nothing is ever reversed: if a balance is never paid, that slice simply never
   releases. total_owed blank (or equal to the amount) means paid in full. */
function collectedFor(row, allRows) {
  const paid = Number(row.amount || 0);
  const follow = (allRows || []).filter(r => r.balance_of === row.id)
    .reduce((a, r) => a + Number(r.amount || 0), 0);
  return +(paid + follow).toFixed(2);
}
function owedFor(row) {
  const total = row.total_owed != null ? Number(row.total_owed) : null;
  const amt = Number(row.amount || 0);
  return (total != null && total > amt) ? total : amt;   // blank => paid in full
}
// share of the fee that has actually been collected, 0..1
function collectedRatio(row, allRows) {
  const owed = owedFor(row);
  if (!(owed > 0)) return 1;
  return Math.min(1, collectedFor(row, allRows) / owed);
}

const owns = (row, email) => (row.commission_to || agentEmailOf(row.agent)) === email;
// Agents can sign into the PORTAL and see ONLY their own data (never admin views, never other agents).
const AGENT_ALLOWLIST = [
  'sammy@speedyins.com', 'yolanda@speedyins.com', 'jorge@speedyins.com', 'lfigueroa@speedyins.com',
  'chris@speedyins.com', 'yasmin@speedyins.com', 'fernando@speedyins.com', 'jesus@speedyins.com',
  'alejandra@speedyins.com', 'esmeralda@speedyins.com', 'irene@speedyins.com',
  'malcolm@speedyins.com', 'melisa@speedyins.com', 'daisy@speedyins.com',
  'tony@speedyins.com', 'lana@speedyins.com',
];
const ALLOWLIST = ADMIN_ALLOWLIST; // back-compat for existing admin checks
const AGENCY_ID = 15112;
const TEST_CLIENT = 26081; // ZZTEST — the only client sync/HawkSoft-read will touch
const HS_BASE = 'https://integration.hawksoft.app';
// HawkSoft office ids (NOT RingCentral office groups — see the calls view).
const OFFICE_MAP = { '1': 'Moreno Valley', '2': 'Riverside Van Buren', '3': 'Riverside Magnolia', '4': 'Lake Elsinore', '5': 'Colton' };
/* The five office NAMES, in office order — served to the Staff page so its branch
   dropdown and this map can never drift apart. Written as a name list because the
   agents table stores the name, not the id. */
const OFFICE_NAMES = Object.keys(OFFICE_MAP).sort().map(k => OFFICE_MAP[k]);

// Carrier name normalization (misspellings / variants -> canonical). Grow as needed.
const CARRIER_NORMALIZE = {
  'MAPFREE': 'MAPFRE',
  'MAPFRE': 'MAPFRE',
  'MCGRAW INSURANCE SERVICES': 'MCGRAW',
  'MCGRAW': 'MCGRAW',
};
function normalizeCarrier(name) {
  if (!name) return null;
  const key = String(name).trim().toUpperCase();
  return CARRIER_NORMALIZE[key] || String(name).trim();
}
// Classify a HawkSoft "policy" container into what it really is.
// Returns { record_type, renewal_months, carrier } — carrier cleared for non-insurance.
function classifyRecord(rawCarrier) {
  const c = String(rawCarrier || '').toUpperCase();
  if (c.includes('DEPARTMENT OF MOTOR VEHICLES') || /\bDMV\b/.test(c)) {
    return { record_type: 'dmv_service', renewal_months: 12, carrier: null };
  }
  if (rawCarrier && rawCarrier.trim()) {
    return { record_type: 'insurance', renewal_months: null, carrier: normalizeCarrier(rawCarrier) };
  }
  return { record_type: 'unknown', renewal_months: null, carrier: null };
}

/* Verified-claims cache.
   The tokeninfo round trip to Google ran on EVERY request - client search fires
   one per keystroke. This remembers Google's answer briefly, keyed by the token.

   Three rules make it safe:
   1. It caches CLAIMS (who Google says this is), never an authorization decision.
      Every caller still applies its own allowlist on the result, so a token
      verified for one endpoint cannot inherit another endpoint's permissions.
   2. An entry NEVER outlives the token itself - ttl is capped by the token's own
      exp claim. A token with 10s left is cached for 10s, not 60.
   3. Failures are never cached. A rejected token is re-checked every time, so
      fixing an allowlist or revoking access takes effect immediately. */
const _claimsCache = new Map();
const CLAIMS_TTL_MS = 60000;

async function googleClaims(idToken) {
  if (!idToken) return null;
  const hit = _claimsCache.get(idToken);
  if (hit) {
    if (hit.until > Date.now()) return hit.claims;
    _claimsCache.delete(idToken);
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (r.status !== 200) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    if (!email) return null;
    const expMs = Number(t.exp) * 1000;
    const ttl = Math.min(CLAIMS_TTL_MS, (expMs || 0) - Date.now());
    const claims = { email };
    if (ttl > 0) {
      if (_claimsCache.size > 500) _claimsCache.clear();
      _claimsCache.set(idToken, { claims, until: Date.now() + ttl });
    }
    return claims;
  } catch { return null; }
}

/* ITEM 70 STEP 3. These two are the only gates that read the roster, and they read it
   ADDITIVELY: rosterAdmins()/rosterAgents() seed from the code list BEFORE the table is
   consulted, so the table can only ever add. Aug 30 broke this exact line by REPLACING
   the code list, which locked the owner out of the tool needed to fix it.

   Three properties, all harness-verified:
     · a failed read, an empty table or a bad row can only fail to ADD
     · the roster read cannot hang the gate (2s timeout above -> code floor)
     · rollback needs NO DEPLOY: set role='agent' in the table and the grant is gone
       within the 60s cache. The code floor means Saif's access cannot be affected
       either way, which is the property that was missing in August. */
async function verifyGoogle(idToken) {
  const c = await googleClaims(idToken);
  if (!c) return null;
  return (await rosterAdmins()).has(c.email) ? c.email : null;
}

// Verify for portal access: returns { email, role } where role is 'admin' or 'agent'.
async function verifyPortal(idToken) {
  const c = await googleClaims(idToken);
  if (!c) return null;
  if ((await rosterAdmins()).has(c.email)) return { email: c.email, role: 'admin' };
  if ((await rosterAgents()).has(c.email)) return { email: c.email, role: 'agent' };
  return null;
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}
/* Fetch one object out of the PRIVATE document bucket, server-side only. Returns
   base64 or null; never throws, so a storage problem degrades to the inline copy
   rather than an error in front of an agent. */
async function storageGet(objectPath) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key || !objectPath) return null;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/storage/v1/object/client-documents/${objectPath}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.status !== 200) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab).toString('base64');
  } catch { return null; }
}

async function sbGet(s, path) {
  const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs });
  return { ok: r.ok, rows: await r.json().catch(() => []) , headers: r.headers };
}
async function sbUpsert(s, table, rows, conflict) {
  const r = await fetch(`${s.base}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}
async function sbInsert(s, table, rows) {
  const r = await fetch(`${s.base}/rest/v1/${table}`, {
    method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status };
}

/* ================= ITEM 70 · ROLES AND PERMISSIONS, STEP 2 =================
   `public.agents` has been seeded and verified since Aug 30 and NOTHING reads it. This
   is the read, and it is the second attempt: the first one took the Console down.

   ⛔ WHAT WENT WRONG LAST TIME (Aug 30). `syncRoster` REPLACED `ADMIN_ALLOWLIST` with
   whatever the table returned, and locked Tony out of the tool needed to fix it. So:

     THE CODE LIST IS THE FLOOR. THE TABLE ONLY EVER ADDS.

   A failed read, an empty result, a truncated response, a bad row - none of them can
   remove anyone's access, because the code list is unioned in unconditionally and the
   table is only ever a source of additions.

   CAPABILITY BUNDLES LIVE HERE, NOT IN THE TABLE. The table stores a role name and a
   list of grant names; what those MEAN is defined in code, so a bad row can never
   invent a permission that the code does not already understand. An unknown role or an
   unrecognised grant string resolves to nothing.

   Placed here, below sbGet/sb, so there is no question about declaration order - the
   v2.7 lesson, and again today with OWED/FEE_LOW in carrier.html. */
const ROLE_CAPS = {
  owner: ['console', 'audit_approve', 'correct', 'refund', 'approve_month', 'manage_agents', 'commission_override'],
  /* audit_approve is NOT an admin default: "Tony + admins with a grant" (Saif, Sep 12).
     It releases commission, so it is handed out by name on the Staff page. */
  admin: ['console', 'correct'],
  agent: [],
};
/* Every capability the system understands. A grant string not in here is ignored. */
const ALL_CAPS = new Set(Object.values(ROLE_CAPS).flat());
/* Send-back reasons an approver can pick. Free text always accompanies the code. */
const AUDIT_SENDBACK_CODES = {
  receipt_missing: 'Receipt missing', receipt_unreadable: 'Receipt unreadable', wrong_amount: 'Wrong amount',
  wrong_carrier: 'Wrong carrier', need_photos: 'Need photos of documents', other: 'Other',
};

let _roster = null, _rosterUntil = 0;
const ROSTER_TTL_MS = 60 * 1000;
/* ⚠️ FAILURES ARE CACHED TOO, and that is not a detail. Only caching SUCCESS meant a
   failing read was retried by every caller: perm_check alone calls may() about 126
   times (every email x every capability), and each one re-ran the 2s timeout - roughly
   four minutes of serial retries for one request. The harness stalled, which is how
   this was found; in production a slow Supabase would stampede identically on any
   handler that asks may() more than once.

   A short negative TTL so a real recovery is picked up quickly, while one bad read
   costs one timeout per request instead of dozens. */
const ROSTER_FAIL_TTL_MS = 10 * 1000;
const emptyRoster = () => { _roster = new Map(); _rosterUntil = Date.now() + ROSTER_FAIL_TTL_MS; return _roster; };
async function loadRoster() {
  if (_roster && Date.now() < _rosterUntil) return _roster;
  const s = sb();
  if (!s) return emptyRoster();
  try {
    /* ⏱ ITS OWN TIMEOUT, not sbGet's — sbGet has none. From step 3 this read sits in
       the AUTHENTICATION path, where `ADMIN_ALLOWLIST.includes()` used to be instant.
       The try/catch below handles a FAILURE; it does not handle a HANG, and a stalled
       Supabase would stall every authenticated request rather than degrading. With
       this, the worst case is "the table adds nobody for a minute" — the code floor
       still answers, so nobody is ever locked out by a slow database. */
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    let r;
    try {
      const resp = await fetch(`${s.base}/rest/v1/agents`
        + '?select=email,full_name,branch,producer_code,active,is_admin,role,grants&limit=200',
        { headers: s.hdrs, signal: ac.signal });
      r = { ok: resp.ok, rows: await resp.json().catch(() => []) };
    } finally { clearTimeout(timer); }
    if (!r.ok || !Array.isArray(r.rows)) return emptyRoster();
    const m = new Map();
    for (const row of r.rows) {
      const email = String(row.email || '').toLowerCase().trim();
      if (!email) continue;
      /* ⛔ THE TABLE MAY ONLY EVER ADD @speedyins.com. Caught by the harness before this
         shipped: ONE row with role='owner' on any address granted the whole Console
         plus approve_month, manage_agents and commission_override - and Google sign-in
         cannot stop it, because verifyGoogle only checks `aud` and `email_verified`,
         which ANY Google account passes. The allowlist is the only thing restricting
         who gets in, so a table that can add arbitrary addresses is the allowlist.

         The row is KEPT and flagged rather than dropped, so a stray one is visible in
         perm_check instead of silently ignored - it should be noticed and removed, not
         quietly tolerated. This narrows what the table can do; it does not replace the
         explicit allowlist with a domain gate, which was rejected for a different
         reason (a departed agent keeps access until Google disables the account). */
      const external = !/@speedyins\.com$/.test(email);
      m.set(email, {
        email,
        external,
        name: row.full_name || null,
        branch: row.branch || null,
        producer_code: row.producer_code || null,
        active: row.active === true,
        role: ROLE_CAPS[row.role] ? row.role : 'agent',   // unknown role => no powers
        grants: Array.isArray(row.grants) ? row.grants.filter(g => ALL_CAPS.has(g)) : [],
      });
    }
    _roster = m; _rosterUntil = Date.now() + ROSTER_TTL_MS;
    return m;
  } catch { return emptyRoster(); }
}

/* Who may sign in. ADDITIVE: code list first, table only adds ACTIVE rows.
   `active` gates SIGN-IN ONLY - a departed agent's name and producer code must still
   render on the payments they wrote, which is why inactive rows are read but never
   granted access. */
async function rosterAdmins() {
  const m = await loadRoster();
  const out = new Set(ADMIN_ALLOWLIST.map(e => e.toLowerCase()));
  for (const a of m.values()) {
    if (a.external) continue;   // the table may only ever ADD @speedyins.com
    if (a.active && (a.role === 'admin' || a.role === 'owner')) out.add(a.email);
  }
  return out;
}
async function rosterAgents() {
  const m = await loadRoster();
  const out = new Set(AGENT_ALLOWLIST.map(e => e.toLowerCase()));
  for (const a of m.values()) if (a.active && !a.external) out.add(a.email);
  return out;
}

/* THE ONE FUNCTION EVERY GUARD CALLS. Refunds, month approval and the agents page all
   ask this instead of comparing an email, so a permission change happens in one place.

   The floor: anyone in the code ADMIN_ALLOWLIST keeps the `admin` bundle no matter what
   the table says, so a table problem can never take away what they can do today. */
async function may(email, cap) {
  const me = String(email || '').toLowerCase().trim();
  if (!me || !ALL_CAPS.has(cap)) return false;
  const caps = new Set();
  if (ADMIN_ALLOWLIST.map(e => e.toLowerCase()).includes(me)) {
    for (const c of ROLE_CAPS.admin) caps.add(c);
  }
  const a = (await loadRoster()).get(me);
  if (a && a.active && !a.external) {
    for (const c of (ROLE_CAPS[a.role] || [])) caps.add(c);
    for (const c of a.grants) caps.add(c);
  }
  return caps.has(cap);
}

function hsAuth() {
  const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) return null;
  return 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
}
async function hsCall(path, opts = {}) {
  const AUTH = hsAuth();
  if (!AUTH) return { error: 'HawkSoft env vars missing' };
  const r = await fetch(HS_BASE + path, { ...opts, headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
const hsFetchClient = (no = TEST_CLIENT) => hsCall(`/vendor/agency/${AGENCY_ID}/client/${no}?version=4.0&include=Details,People,Contacts,Policies,Invoices`);
const hsAllClientIds = () => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&asOf=2000-01-01T00:00:00Z`);
const hsChangedSince = (iso) => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&asOf=${encodeURIComponent(iso)}`);
const hsClientBatch = (ids) => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&include=Details,People,Contacts,Policies`, { method: 'POST', body: JSON.stringify({ clientNumbers: ids }) });

const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
const dateOnly = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

/* ============ Shared: map + upsert one HawkSoft client object ============ */
async function upsertHsClient(s, c) {
  const cn = Number(pick(c, 'clientNumber', 'clientNo', 'number', 'id', 'Id'));
  if (!isFinite(cn)) return { ok: false, error: 'no client number' };
  const people = c.people || [];
  const p0 = people[0] || {};
  const details = c.details || {};
  const addr = details.mailingAddress || details.physicalAddress || {};
  const contacts = c.contacts || [];
  const phone = (contacts.find(x => /phone|cell|mobile/i.test(x.type || '')) || {}).data || null;
  const email = (contacts.find(x => /email/i.test(x.type || '')) || {}).data || null;
  const officeId = details.officeId != null ? details.officeId : c.officeId;
  // Find the TRUE named insured from policy drivers (relationship='Insured' / status='Principal').
  // people[0] is unreliable — it can be an excluded driver. Drivers carry the real role.
  let insuredFirst = null, insuredLast = null;
  const polsForName = c.policies || c.Policies || [];
  outer: for (const pol of polsForName) {
    for (const dr of (pol.drivers || pol.Drivers || [])) {
      const rel = String(dr.relationship || '').toLowerCase();
      const st = String((dr.personalInfo && dr.personalInfo.status) || '').toLowerCase();
      if (rel === 'insured' || st === 'principal') {
        insuredFirst = dr.firstName || null;
        insuredLast = dr.lastName || null;
        break outer;
      }
    }
  }
  const clientRow = {
    client_no: cn,
    kind: details.isCommercial ? 'business' : 'person',
    first_name: insuredFirst || p0.firstName || null,
    last_name: insuredLast || p0.lastName || null,
    business_name: details.companyName || details.dbaName || null,
    email,
    phone,
    address1: addr.address1 || null,
    city: addr.city || null,
    state: addr.state || null,
    zip: addr.zip || null,
    branch: OFFICE_MAP[String(officeId)] || (officeId != null ? 'Office ' + officeId : null),
    status: details.status || 'Active',
    extras: { office_id: officeId ?? null, client_type: details.clientType || null, producer: details.producer || null, source: details.source || null, hawksoft_snapshot_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  };
  const up1 = await sbUpsert(s, 'clients', [clientRow], 'client_no');
  if (!up1.ok) return { ok: false, error: 'clients upsert failed', detail: up1.body };
  const ourClient = up1.body && up1.body[0];
  const hsPols = c.policies || c.Policies || [];
  let polCount = 0;
  for (const p of hsPols) {
    const guid = pick(p, 'id', 'policyId', 'guid', 'Id', 'PolicyId');
    const _cls = classifyRecord(p.carrier || p.writingCarrier);
    const row = {
      client_id: ourClient.id,
      client_no: cn,
      hs_policy_guid: p.id ? String(p.id) : (guid ? String(guid) : null),
      policy_number: p.policyNumber || null,
      lob: (Array.isArray(p.loBs) && p.loBs.length ? p.loBs.map(l => (l && (l.lineOfBusiness || l.lob || l.code || l.type)) || l).filter(Boolean).join(', ') : null) || p.applicationType || p.title || p.type || null,
      carrier: _cls.carrier,
      carrier_normalized: _cls.carrier,
      record_type: _cls.record_type,
      renewal_months: _cls.renewal_months,
      effective_date: dateOnly(p.effectiveDate),
      expiration_date: dateOnly(p.expirationDate),
      premium: (p.premium != null ? Number(p.premium) : null),
      status: p.status || 'Active',
      billing: p.billingType || null,
      carrier_extras: p,
      updated_at: new Date().toISOString(),
    };
    const up = await sbUpsert(s, 'policies', [row], 'hs_policy_guid');
    if (up.ok) polCount++;
  }
  return { ok: true, client_no: cn, policies: polCount };
}


/* ---------- Link a down payment to the policy it bought ----------
   The agency charges the client FIRST and buys the policy with that money, so at
   charge time there is often no policy at all. Every one of the 9 unlinked charges
   on record is a Down payment - it is the signature of new business, not an error.
   The receipt therefore files at client level, and HawkSoft has no receipt-modify
   endpoint, so it stays there permanently.

   What we CAN do is make our own record true once the policy arrives, and leave a
   note in HawkSoft so an auditor can follow the money.

   MATCHING USES CLIENT AND TIMING, NOT AMOUNT. Two down payments can be the same
   figure; the client and the date the policy took effect are far stronger. Tested
   against all 9 real cases: 7 resolve to exactly one candidate, 2 have none yet
   because the policy has not been bought (both charged today). ZERO ambiguous.

   ONE CANDIDATE OR ABSTAIN - the same rule as resolvePolicyGuid. A wrong link would
   put money against a policy it did not buy, and the HawkSoft note cannot be
   deleted afterwards. */
async function linkDownPayments(s, clientNo, actor) {
  const out = { checked: 0, linked: 0, ambiguous: 0, none: 0 };
  try {
    const open = await sbGet(s, `bridge_ledger?client_id=eq.${clientNo}`
      + `&extra->>policyLink=eq.${encodeURIComponent('no policy # given')}`
      + `&is_test=is.false&select=id,ts,amount,purpose,extra&limit=20`);
    const rows = open.rows || [];
    if (!rows.length) return out;

    const pol = await sbGet(s, `policies?client_no=eq.${clientNo}`
      + `&select=policy_number,carrier,status,effective_date,hs_policy_guid,carrier_extras`);
    const all = pol.rows || [];

    for (const r of rows) {
      out.checked++;
      const charged = new Date(r.ts);
      /* A policy bought with this money takes effect around the charge - a little
         before if backdated, a couple of weeks after at most. Anything outside that
         is a different policy. */
      const from = new Date(charged.getTime() - 3 * 864e5);
      const to   = new Date(charged.getTime() + 14 * 864e5);
      const cands = all.filter(x => {
        if (!/^new/i.test(String(x.status || ''))) return false;
        if (!x.effective_date) return false;
        const eff = new Date(x.effective_date + 'T12:00:00Z');
        return eff >= from && eff <= to;
      });
      if (cands.length === 0) { out.none++; continue; }
      if (cands.length > 1)  { out.ambiguous++; continue; }   // abstain, never guess

      const hit = cands[0];
      const extra = Object.assign({}, r.extra || {}, {
        /* Says HOW it was linked. Anywhere a payment is shown, an inference must not
           be mistaken for something the agent chose. */
        policyLink: 'linked retroactively by sync',
        policyNumber: hit.policy_number || null,
        policyCarrier: hit.carrier || null,
        policyGuid: hit.hs_policy_guid || null,
        retroLinkedAt: new Date().toISOString(),
      });
      await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${r.id}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ extra }),
      });

      /* The EVIDENCE, not just the conclusion. If a link is ever wrong this row
         explains how it was made. */
      await sbInsert(s, 'events', [{
        actor: actor || 'sync', kind: 'payment.policy_linked', client_no: clientNo,
        source: 'hawksoft_sync',
        payload: {
          payment_id: r.id, amount: Number(r.amount), purpose: r.purpose,
          charged_at: r.ts,
          policy_number: hit.policy_number, carrier: hit.carrier,
          policy_effective: hit.effective_date,
          candidates_considered: cands.length,
          rule: 'single New policy effective within -3/+14 days of the charge; amount not used',
        },
      }]);
      out.linked++;
      out.notes = out.notes || [];
      out.notes.push({ payment_id: r.id, client_no: clientNo, amount: Number(r.amount),
        charged_at: r.ts, policy_number: hit.policy_number, carrier: hit.carrier,
        policy_guid: hit.hs_policy_guid,
        tab: (hit.carrier_extras && hit.carrier_extras.policyIndex != null)
             ? Number(hit.carrier_extras.policyIndex) + 1 : null });
    }
  } catch (e) {
    /* Never let this break a sync. A missed link is recoverable on the next run; a
       failed sync is not. */
    out.error = String(e).slice(0, 160);
  }
  return out;
}

/* Hanging the linker off "clients this sync touched" was too narrow, and every real
   case proved it: all 7 resolvable payments had their policies synced DAYS earlier -
   08-26, 08-31, 09-01, 09-02 - so the watermark had long moved past those clients and
   they would never be pulled again. The link would only ever have fired when a policy
   happened to arrive in the same run.

   So the sweep looks at UNLINKED PAYMENTS, not at changed clients. Cheap: it reads
   the handful of down payments still carrying 'no policy # given' and checks each
   client's policies, which are already in our own tables. */
async function sweepUnlinkedPayments(s, actor) {
  const out = { linked: 0, notes: [] };
  try {
    const open = await sbGet(s, `bridge_ledger`
      + `?extra->>policyLink=eq.${encodeURIComponent('no policy # given')}`
      + `&is_test=is.false&select=client_id&order=ts.desc&limit=60`);
    const clients = [...new Set((open.rows || []).map(r => Number(r.client_id)).filter(isFinite))];
    for (const cn of clients) {
      const r = await linkDownPayments(s, cn, actor);
      out.linked += r.linked || 0;
      if (r.notes) out.notes.push(...r.notes);
    }
  } catch (e) { out.error = String(e).slice(0, 160); }
  return out;
}

async function runDeltaSync(s, actor, budgetMs) {
  const st = await sbGet(s, 'sync_state?key=eq.hawksoft_clients&select=*');
  const last = (st.rows && st.rows[0] && st.rows[0].last_sync) || '2026-07-23T00:00:00Z';
  // 30-min safety overlap so nothing slips between runs
  const asOf = new Date(new Date(last).getTime() - 30 * 60 * 1000).toISOString();
  const startedAt = new Date().toISOString();

  const hs = await hsChangedSince(asOf);
  if (hs.error || hs.status !== 200) return { ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status) };
  const ids = Array.isArray(hs.body) ? hs.body.map(Number).filter(isFinite) : [];

  let clients = 0, pols = 0, done = 0, linked = 0;
  const pendingNotes = [];
  const began = Date.now();
  // Cron can afford to grind; a button cannot. Caller decides.
  const BUDGET_MS = Number(budgetMs) > 0 ? Number(budgetMs) : 240000;
  let ranOut = false;
  for (let i = 0; i < ids.length; i += 25) {
    if (Date.now() - began > BUDGET_MS) { ranOut = true; break; }
    const batch = ids.slice(i, i + 25);
    const b = await hsClientBatch(batch);
    done = i + batch.length;
    if (b.error || b.status !== 200) continue;
    for (const c of (Array.isArray(b.body) ? b.body : [])) {
      const r = await upsertHsClient(s, c);
      if (r.ok) {
        clients++; pols += r.policies;
        /* Linking happens in one sweep after the loop - see sweepUnlinkedPayments.
           Doing it per client here only ever caught policies arriving in the same
           run, which is not how this actually happens. */
      }
    }
  }

  // Only advance the watermark when the whole window was processed. If we ran out of
  // time, leave it where it was so the next press picks up the same window and keeps
  // going — a four-day gap is caught up by pressing the button a few times.
  /* Every unlinked payment, not only the clients this run happened to touch. */
  const swept = await sweepUnlinkedPayments(s, actor);
  linked += swept.linked || 0;
  if (swept.notes) pendingNotes.push(...swept.notes);

  /* ---------- The note an auditor in CMS actually needs ----------
     The receipt is already filed at CLIENT LEVEL and HawkSoft has no receipt-modify
     endpoint, so it can never be moved onto the policy. Without a note, somebody
     opening that client finds money with no policy attached and no explanation.
     Written to the POLICY tab via PolicyId, so it sits where the money belongs.

     Only for unambiguous matches - a HawkSoft log note cannot be deleted either, so
     a wrong one is permanent. Channel 32 = Online From 3rd Party, the same channel
     the bridge already uses. */
  let noteOk = 0, noteFail = 0;
  for (const n of pendingNotes) {
    try {
      const when = new Date(n.charged_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const note =
        `$${n.amount.toFixed(2)} down payment taken ${when} filed at CLIENT LEVEL — `
        + `the policy had not been issued yet, and HawkSoft receipts cannot be moved afterwards. `
        + `This payment bought ${n.policy_number || '(policy number pending)'}`
        + (n.carrier ? ` — ${n.carrier}` : '')
        + (n.tab ? `, tab ${n.tab}` : '')
        + `. Matched automatically by the Speedy platform when the policy synced.`;
      /* A SINGLE OBJECT, not an array. hawksoft.js has posted log notes this way for
         months; I rewrote it from scratch instead of copying it, wrapped the body in
         an array, and HawkSoft rejected all nine. */
      const lr = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${n.client_no}/log?version=4.0`, {
        method: 'POST',
        body: JSON.stringify({
          refId: crypto.randomUUID(),
          ts: new Date().toISOString(), channel: 32,
          note: note.slice(0, 3000),
          ...(n.policy_guid ? { policyId: n.policy_guid } : {}),
        }),
      });
      const okNote = lr && (lr.status === 200 || lr.status === 202);
      noteOk += okNote ? 1 : 0;
      if (okNote) {
        await sbInsert(s, 'events', [{ actor: actor || 'sync', kind: 'payment.note_sent',
          client_no: n.client_no, source: 'hawksoft_sync',
          payload: { payment_id: n.payment_id, policy_number: n.policy_number } }]);
      }
      if (!okNote) {
        /* The silent catch is what hid this: the sync reported success while every
           note failed. A failure now leaves a row that can be found. */
        noteFail++;
        await sbInsert(s, 'events', [{ actor: actor || 'sync', kind: 'payment.note_failed',
          client_no: n.client_no, source: 'hawksoft_sync',
          payload: { payment_id: n.payment_id, status: lr && lr.status,
                     body: JSON.stringify(lr && lr.body).slice(0, 300) } }]);
      }
    } catch (e) {
      noteFail++;
      try { await sbInsert(s, 'events', [{ actor: actor || 'sync', kind: 'payment.note_failed',
        client_no: n.client_no, source: 'hawksoft_sync',
        payload: { payment_id: n.payment_id, error: String(e).slice(0, 200) } }]); } catch {}
    }
  }

  if (!ranOut) {
    await fetch(`${s.base}/rest/v1/sync_state?key=eq.hawksoft_clients`, {
      method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_sync: startedAt, last_count: clients, note: 'delta sync', updated_at: startedAt }),
    });
  }
  await sbInsert(s, 'events', [{ actor, kind: 'sync.completed', source: 'hawksoft_sync',
    payload: { changed_ids: ids.length, clients_updated: clients, policies_updated: pols,
               payments_linked: linked, notes_written: noteOk, notes_failed: noteFail,
               as_of: asOf } }]);
  return { ok: true, changed: ids.length, clients, policies: pols, payments_linked: linked,
           notes_written: noteOk, notes_failed: noteFail,
           as_of: asOf, partial: ranOut, processed: done };
}

async function sbPatch(s, path, obj) {
  return fetch(`${s.base}/rest/v1/${path}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify(obj) });
}
// Process up to CHUNK ids of a resync job, then return. Cron calls this repeatedly until done.
async function stepResyncJob(s, job, budgetMs) {
  const CHUNK = 25;
  const ids = Array.isArray(job.ids) ? job.ids : [];
  let cursor = job.cursor || 0;
  let cU = job.clients_updated || 0, pU = job.policies_updated || 0;
  const deadline = Date.now() + (budgetMs || 45000);
  while (cursor < ids.length && Date.now() < deadline) {
    const batch = ids.slice(cursor, cursor + CHUNK);
    const b = await hsClientBatch(batch);
    if (!b.error && b.status === 200) {
      for (const c of (Array.isArray(b.body) ? b.body : [])) {
        const r = await upsertHsClient(s, c);
        if (r.ok) { cU++; pU += r.policies; }
      }
    }
    cursor += batch.length;
    await sbPatch(s, `sync_jobs?id=eq.${job.id}`, { cursor, processed: cursor, clients_updated: cU, policies_updated: pU, status: 'running', updated_at: new Date().toISOString() });
  }
  const done = cursor >= ids.length;
  await sbPatch(s, `sync_jobs?id=eq.${job.id}`, { cursor, processed: cursor, clients_updated: cU, policies_updated: pU, status: done ? 'done' : 'running', updated_at: new Date().toISOString() });
  if (done) {
    await sbPatch(s, `sync_state?key=eq.hawksoft_clients`, { last_sync: new Date().toISOString(), last_count: cU, note: 'full resync (server job)', updated_at: new Date().toISOString() });
    await sbInsert(s, 'events', [{ actor: job.started_by || 'system:job', kind: 'resync.completed', source: 'hawksoft_sync', payload: { clients: cU, policies: pU, total: ids.length } }]);
  }
  return { done, cursor, total: ids.length, clients: cU, policies: pU };
}
async function getActiveJob(s) {
  const r = await sbGet(s, "sync_jobs?status=in.(pending,running)&order=created_at.desc&limit=1");
  return (r.rows || [])[0] || null;
}

/* THE REFUND, AS A FUNCTION. Two callers: refund_payment (an owner acting directly)
   and decide_refund (an owner approving an agent's request). One code path, so an
   approved request is issued exactly as if Tony had opened the sheet himself, with
   the agent's answers. Returns { status, body } — the `res` here is a shim whose
   .status(n).json(b) yields that object, so the body below is the shipped handler
   verbatim and did not have to be re-read line by line for a refactor. */
async function issueRefund(s, me2, b3, opts = {}) {
  const res = { status: c => ({ json: b => ({ status: c, body: b }) }) };
      const paymentId = String(b3.payment_id || '').trim();
      const reason = String(b3.reason || '').trim();
      const carrier = String(b3.carrier || '').trim();
      const note = String(b3.note || '').trim().slice(0, 400);
      const wantAmount = b3.amount != null ? Number(b3.amount) : null;

      /* THE CLOSED SET, and what each answer MEANS for what the client owes. Saif,
         Sep 10, asked and answered: the first two mean we took money we should not
         have, so the client still owes what they owed; the second two mean the
         obligation itself is gone. The database enforces the same list — a handler is
         not the only way a row can be created. */
      const REASONS = {
        charged_twice:    { owes: true,  label: 'charged twice' },
        wrong_amount:     { owes: true,  label: 'wrong amount taken' },
        policy_cancelled: { owes: false, label: 'policy cancelled' },
        never_bound:      { owes: false, label: 'never bound' },
        /* The conservative default. Leaving the obligation standing errs towards the
           client still owing, which is recoverable; writing it off is not. */
        other:            { owes: true,  label: 'other' },
      };
      if (!paymentId) return res.status(400).json({ ok: false, error: 'payment_id required' });
      if (!REASONS[reason]) return res.status(400).json({ ok: false, error: 'Pick why this is being refunded.' });
      if (!['yes', 'no', 'pending'].includes(carrier)) {
        return res.status(400).json({ ok: false, error: 'Say whether the carrier is giving their money back: yes, no, or not yet.' });
      }
      if (!note) return res.status(400).json({ ok: false, error: 'A reason in words is required — Tony and the next person will read it.' });

      /* ---- TELL THE CLIENT. Validated BEFORE any money moves, so a malformed notice
         cannot leave a refund half-recorded. Email only for now (Saif, Sep 11): the
         one SMS-capable number is a 747 area code and the branches are 951/909.
           channel 'email' + to + source ('on_file' | 'typed')
           channel 'none'  + skip_reason
         'typed' is allowed — a client whose record has no email still has to be told
         somehow — but it is stored and displayed as typed by the agent, because a
         mistyped address is how a refund notice with the client's name and amount
         reaches a stranger. 'on_file' is checked against the record, not trusted. */
      const nz = (b3.notify && typeof b3.notify === 'object') ? b3.notify : null;
      if (!nz) return res.status(400).json({ ok: false, error: 'Say whether to tell the client — an email address, or why not.' });
      const nzChannel = String(nz.channel || '').trim();
      const nzTo = String(nz.to || '').trim().toLowerCase();
      const nzSource = String(nz.source || '').trim();
      const nzSkip = String(nz.skip_reason || '').trim().slice(0, 200);
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (nzChannel === 'email') {
        if (!EMAIL_RE.test(nzTo)) return res.status(400).json({ ok: false, error: 'That is not an email address.' });
        if (nzSource !== 'on_file' && nzSource !== 'typed') {
          return res.status(400).json({ ok: false, error: 'Say whether the address is from the client record or typed.' });
        }
      } else if (nzChannel === 'none') {
        if (!nzSkip) return res.status(400).json({ ok: false, error: 'If the client is not being told, say why — it is recorded.' });
      } else {
        return res.status(400).json({ ok: false, error: "notify.channel must be 'email' or 'none'." });
      }

      /* The payment AND everything already pointing at it, in one read: the balance
         payments that added to it, and any refunds already taken off. */
      const pr = await sbGet(s, 'bridge_ledger?or=(id.eq.' + encodeURIComponent(paymentId)
        + ',balance_of.eq.' + encodeURIComponent(paymentId)
        + ',refund_of.eq.' + encodeURIComponent(paymentId) + ')&select=*');
      const all = pr.rows || [];
      const row = all.find(r => r.id === paymentId);
      if (!row) return res.status(404).json({ ok: false, error: 'No such payment.' });

      /* 'on_file' is a claim until it is checked. The synced client record holds one
         email; HawkSoft may hold a second, which portal_client also returns. Either
         counts. Anything else claimed as on-file is refused rather than relabelled. */
      let onFile = [];
      if (nzChannel === 'email') {
        const cr = await sbGet(s, `clients?client_no=eq.${encodeURIComponent(row.client_id)}&select=email,extras`);
        const crow = (cr.rows || [])[0] || {};
        onFile = [crow.email, ...(((crow.extras || {}).emails) || [])]
          .filter(Boolean).map(e => String(e).trim().toLowerCase());
        if (nzSource === 'on_file' && !onFile.includes(nzTo)) {
          return res.status(400).json({ ok: false,
            error: 'That address is not on the client record. Pick one that is, or mark it as typed.' });
        }
      }

      /* ---- GUARDS. Every one is a way to send real money somewhere wrong. ---- */
      if (row.kind === 'charge_refund') {
        return res.status(400).json({ ok: false, error: 'That row is itself a refund.' });
      }
      /* A balance payment carries no obligation of its own — the original holds it, and
         the single fee. Refunding the child would leave the parent's total_owed untouched
         and the client apparently still owing money they had been given back. Item 76. */
      if (row.balance_of) {
        return res.status(400).json({ ok: false,
          error: 'That payment pays down an earlier charge. Refund the original — it carries the obligation and the fee.' });
      }
      /* NOT /link/. That matched paylink_CHARGE — a paid pay link, which IS collected
         money — and refused to refund the very $1 Saif paid through a link to test this.
         The same mistake as /refund/ matching charge_refund, a day after writing it
         down. Name the one kind that is a link that was only SENT; test the rest by
         audit_status, which is what actually says whether money arrived. */
      if (/declin|fail|void/i.test(String(row.kind || '')) || row.kind === 'paylink_create'
          || ['declined', 'link_sent', 'not_a_payment', 'void'].includes(row.audit_status)) {
        return res.status(400).json({ ok: false, error: 'That row never collected any money.' });
      }
      if (row.correction_status === 'pending') {
        return res.status(400).json({ ok: false, error: 'That payment is waiting on Tony for a different correction. Settle that one first.' });
      }

      /* WHAT IS ACTUALLY REFUNDABLE — not row.amount. The obligation may have been paid
         in two parts, and some of it may already have been refunded. */
      const kids = all.filter(r => r.id !== paymentId);
      const balances = kids.filter(r => r.balance_of === paymentId && r.kind !== 'charge_refund');
      const priorRefunds = kids.filter(r => r.refund_of === paymentId);
      const collected = +(Number(row.amount || 0)
        + balances.reduce((a, r) => a + Number(r.amount || 0), 0)).toFixed(2);
      /* Refund amounts are stored NEGATIVE, so Math.abs once here rather than sign
         juggling at four call sites. */
      const alreadyRefunded = +Math.abs(priorRefunds.reduce((a, r) => a + Number(r.amount || 0), 0)).toFixed(2);
      const refundable = +(collected - alreadyRefunded).toFixed(2);
      if (!(refundable > 0)) {
        return res.status(400).json({ ok: false,
          error: alreadyRefunded > 0
            ? 'That payment has already been refunded in full.'
            : 'There is nothing collected on that payment to refund.' });
      }
      /* Fully collected only — see the header. Compared with a cent of tolerance
         because these are numeric strings out of PostgREST. */
      const owedTotal = (row.total_owed != null && Number(row.total_owed) > Number(row.amount || 0))
        ? Number(row.total_owed) : Number(row.amount || 0);
      if (collected + 0.004 < owedTotal) {
        return res.status(400).json({ ok: false, error: 'partly_paid_not_supported_yet',
          message: `That obligation is only part paid — $${collected.toFixed(2)} of $${owedTotal.toFixed(2)}. `
            + 'Refunding a part-paid obligation changes the commission arithmetic and is stage 4. '
            + 'Ask Saif rather than working around it.' });
      }
      if (wantAmount != null && Math.abs(wantAmount - refundable) > 0.004) {
        return res.status(400).json({ ok: false, error: 'partial_not_supported_yet',
          message: `Only a full refund of $${refundable.toFixed(2)} can be issued today. `
            + 'Whether Clover accepts a partial amount is still unverified, and getting it wrong '
            + 'refunds more than intended.' });
      }
      const amount = refundable;

      const isCard = /^(charge_live|charge_card|paylink_charge|terminal_charge)$/.test(String(row.kind))
        && !!row.txn_id;
      /* DRY RUN — request_refund's whole point. Every guard above has passed, nothing
         has been touched, and this says what WOULD happen. A request is only accepted
         if it would succeed right now; a request that would be refused later is
         refused now, to the person who can fix it. */
      if (opts.dryRun) {
        return res.status(200).json({ ok: true, dry_run: true, amount, method: isCard ? 'card' : 'cash',
          client_id: row.client_id, is_test: row.is_test === true,
          obligation: REASONS[reason].owes ? 'still_owed' : 'closed',
          fee_to_reverse: row.fee_amount != null ? Number(row.fee_amount)
            : (row.service_cost != null ? +(Number(row.amount || 0) - Number(row.service_cost)).toFixed(2) : null),
          notify: { channel: nzChannel, to: nzChannel === 'email' ? nzTo : null,
            source: nzChannel === 'email' ? nzSource : null, skip_reason: nzChannel === 'none' ? nzSkip : null } });
      }

      /* ---- THE CARD. NOTHING IS WRITTEN UNTIL THIS SUCCEEDS. ---- */
      let clover = null, cloverStatus = null;
      if (isCard) {
        const PRIV = process.env.CLOVER_ECOMM_PRIVATE;
        if (!PRIV) return res.status(500).json({ ok: false, error: 'CLOVER_ECOMM_PRIVATE env var not set in Vercel' });
        /* POST /v1/refunds { charge } — the creation route, PROVEN by the stage 0 probe
           rather than assumed: an empty body drew a real validation error ("Either
           charge id or reversal id has to be present"), and a route that cannot exist
           answers differently, so a 404 here means "no such charge". */
        try {
          const cr = await fetch('https://scl.clover.com/v1/refunds', {
            method: 'POST',
            headers: { Authorization: `Bearer ${PRIV}`, 'Content-Type': 'application/json',
              /* Keyed on the PAYMENT, not on the request, so a double-tap from a slow
                 phone cannot refund the same charge twice. */
              'idempotency-key': 'refund-' + paymentId },
            body: JSON.stringify({ charge: row.txn_id }),
          });
          cloverStatus = cr.status;
          const ctext = await cr.text();
          try { clover = ctext ? JSON.parse(ctext) : null; } catch { clover = ctext; }
        } catch (e) {
          return res.status(502).json({ ok: false,
            error: 'Could not reach Clover. Nothing was refunded and nothing was recorded — try again.' });
        }
        const succeeded = cloverStatus === 200 && clover
          && (String(clover.status || '').toLowerCase() === 'succeeded' || !!clover.id);
        if (!succeeded) {
          const msg = (clover && clover.error && clover.error.message)
            || (clover && clover.message) || `Clover returned HTTP ${cloverStatus}`;
          /* Recorded, so a refused refund is not invisible — but NO ledger row: the
             money did not move, so the ledger must not say it did. */
          await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify({ ts: new Date().toISOString(), actor: me2, kind: 'refund.failed',
              client_no: row.client_id, source: 'portal',
              payload: { payment_id: paymentId, amount, reason, carrier,
                clover_status: cloverStatus, clover_error: msg } }) });
          return res.status(402).json({ ok: false, error: `Clover refused the refund: ${msg}` });
        }
      }

      /* ---- THE LEDGER ROW. Negative, pointing at its parent, carrying the reversal. ---- */
      const stamp = new Date().toISOString();
      const refundId = randomUUID();
      /* The fee that was actually recognised on the parent. Null when the parent was
           never audited — then there is no commission to take back, and the commission
           loop skips a row with no fee, which is the correct outcome rather than a zero. */
      const parentFee = row.fee_amount != null ? Number(row.fee_amount)
        : (row.service_cost != null ? +(Number(row.amount || 0) - Number(row.service_cost)).toFixed(2) : null);
      const refundRow = {
        id: refundId,
        ts: stamp,
        kind: 'charge_refund',
        client_id: row.client_id,
        amount: -amount,
        purpose: 'Refund — ' + REASONS[reason].label,
        agent: me2,
        /* WHOSE COMMISSION MOVES: the person who earned the original, not whoever
           pressed the button. "A refund reduces commission in the month of the refund"
           says nothing about moving it to a different agent. */
        commission_to: row.commission_to || agentEmailOf(row.agent) || null,
        txn_id: isCard ? (String((clover && clover.id) || '') || null) : null,
        ref: isCard ? 'Clover refund' : 'Cash returned',
        /* 'complete' and a NEGATIVE fee are what make the existing commission engine
           put a negative line in THIS month. See the header. */
        audit_status: 'complete',
        audit_completed_at: stamp,
        audit_completed_by: me2,
        fee_amount: parentFee != null ? -parentFee : null,
        is_test: row.is_test === true,
        refund_of: paymentId,
        refund_reason: reason,
        refund_carrier: carrier,
        refund_note: note,
        /* Written with the row, result 'pending', and patched once the send has been
           attempted — so even a crash between the two leaves a record that says what
           was DECIDED, which is never silent. */
        extra: { client_notice: { channel: nzChannel, to: nzChannel === 'email' ? nzTo : null,
          source: nzChannel === 'email' ? nzSource : null, chosen_by: me2, at: stamp,
          skip_reason: nzChannel === 'none' ? nzSkip : null,
          result: nzChannel === 'email' ? 'pending' : 'skipped',
          detail: nzChannel === 'none' ? nzSkip : null } },
      };
      const ins = await sbInsert(s, 'bridge_ledger', [refundRow]);
      if (!ins.ok) {
        /* THE WORST CASE, SAID OUT LOUD. The card is refunded and we could not record
           it. Staying quiet here is how a client gets refunded twice. */
        return res.status(500).json({ ok: false,
          error: 'The card WAS refunded but the ledger write failed (' + ins.status + '). '
            + 'Do NOT try again — tell Saif. The Clover refund id is below and the row must be added by hand.',
          clover_refund_id: (clover && clover.id) || null });
      }

      /* ---- DOES THE CLIENT STILL OWE IT? Saif's split, applied. ---- */
      const owedBefore = row.total_owed != null ? Number(row.total_owed) : null;
      let owedAfter = owedBefore;
      if (!REASONS[reason].owes && owedBefore != null) {
        /* The obligation is gone, so what is owed drops to what is still held. Only
           touched when a total_owed was set in the first place — writing one onto a
           charge that never had one would invent an obligation. */
        owedAfter = +(collected - alreadyRefunded - amount).toFixed(2);
        await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ total_owed: owedAfter }) });
      }

      /* ---- TELL THE CLIENT — after the money has moved AND been recorded, never before.
         The result is patched onto the row and goes into the HawkSoft note and the
         event below, so there is no outcome that is not written down. ---- */
      const notice = refundRow.extra.client_notice;
      if (nzChannel === 'email') {
        const crn = await sbGet(s, `clients?client_no=eq.${encodeURIComponent(row.client_id)}&select=first_name,business_name`);
        const cn = (crn.rows || [])[0] || {};
        const ageMin = Math.round((Date.now() - new Date(row.ts).getTime()) / 60000);
        const r = await sendRefundEmail({
          to: nzTo, name: cn.business_name || cn.first_name || '',
          amount, method: isCard ? 'card' : 'cash', voided: isCard && ageMin < 25,
          original: `$${Number(row.amount || 0).toFixed(2)} on ${String(row.ts || '').slice(0, 10)}${row.ref ? ' · ' + row.ref : ''}`,
          reason: REASONS[reason].label, confirmation: (clover && clover.id) || null,
          stamp: new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) });
        notice.result = r.startsWith('sent to') ? 'sent' : 'failed';
        notice.detail = r.startsWith('sent to') ? null : r;
        await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(refundId)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ extra: { client_notice: notice } }) });
      }
      const noticeLine = notice.result === 'sent'
        ? `Client notified by email at ${notice.to}${notice.source === 'typed' ? ' (address typed by the agent, not from the record)' : ''}.`
        : notice.result === 'failed'
          ? `Client email to ${notice.to} FAILED (${notice.detail}) — the agent was shown this.`
          : `Client NOT notified — ${notice.skip_reason}.`;

      /* ---- HAWKSOFT. A filed receipt cannot be un-filed or modified, so the refund goes
         on as a NOTE and the original receipt stays exactly where it is. Saying so on the
         client's file is the only way the record does not quietly lie. ---- */
      let noteOk = false;
      try {
        const hr = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${row.client_id}/log?version=4.0`, {
          method: 'POST',
          body: JSON.stringify({ refId: randomUUID(), ts: stamp, channel: 32,
            note: `REFUND — $${amount.toFixed(2)} returned to the client `
              + (isCard
                  ? `on the card used for the original payment (Clover refund ${(clover && clover.id) || 'n/a'}).`
                  : `in cash by the agent.`)
              + ` The original payment of $${Number(row.amount || 0).toFixed(2)} on `
              + `${String(row.ts || '').slice(0, 10)}${row.txn_id ? ' (' + row.txn_id + ')' : ''} REMAINS ON FILE `
              + `and is unchanged — a filed receipt cannot be withdrawn. `
              + `Reason: ${REASONS[reason].label}. `
              + (REASONS[reason].owes
                  ? `The client still owes what they owed; this does not write the balance off. `
                  : `This closes the obligation — nothing further is owed on it. `)
              + `Carrier money: ${carrier === 'yes' ? 'returned by the carrier'
                  : carrier === 'no' ? 'NOT returned — absorbed by Speedy' : 'not returned yet'}. `
              + noticeLine + ` `
              + `Refunded by ${me2}. Note: ${note}` }) });
        noteOk = (hr.status === 200 || hr.status === 202);
      } catch { noteOk = false; }

      /* ---- THE AUDIT TRAIL. Everything that moved, so "why did this money go back?" is
         answerable later without anyone reconstructing it from memory. ---- */
      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: stamp, actor: me2, kind: 'payment.refunded',
          client_no: row.client_id, source: 'portal',
          payload: {
            payment_id: paymentId, refund_id: refundId,
            amount, method: isCard ? 'card' : 'cash',
            clover_refund_id: (clover && clover.id) || null,
            reason, reason_label: REASONS[reason].label,
            obligation: REASONS[reason].owes ? 'still owed' : 'closed',
            total_owed: { from: owedBefore, to: owedAfter },
            carrier, carrier_cost: row.service_cost != null ? Number(row.service_cost) : null,
            fee_reversed: parentFee,
            commission_to: refundRow.commission_to,
            hawksoft_note: noteOk, note,
            client_notice: notice,
          } }) });

      return res.status(200).json({ ok: true,
        refund_id: refundId,
        client_notice: notice,
        amount, method: isCard ? 'card' : 'cash',
        clover_refund_id: (clover && clover.id) || null,
        obligation: REASONS[reason].owes ? 'still_owed' : 'closed',
        total_owed_now: owedAfter,
        fee_reversed: parentFee,
        hawksoft_note: noteOk,
        /* The one thing the agent will be asked, in the words to use. */
        tell_the_client: isCard
          ? `$${amount.toFixed(2)} is on its way back to the card — usually 2 to 5 business days.`
          : `Hand back $${amount.toFixed(2)} in cash.`,
      });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  /* ---- Cron entry (Vercel Cron): /api/platform?view=cron_sync ---- */
  if (req.method === 'GET' && String(req.query.view || '') === 'cron_sync') {
    const secret = process.env.CRON_SECRET || '';
    const authed = secret
      ? req.headers.authorization === `Bearer ${secret}`
      : !!req.headers['x-vercel-cron'];
    if (!authed) return res.status(401).json({ ok: false, error: 'Not authorized' });
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });
    const job = await getActiveJob(s);
    if (job) { const j = await stepResyncJob(s, job, 50000); return res.status(200).json({ ok: true, mode: 'resync_job', ...j }); }
    const out = await runDeltaSync(s, 'system:cron');
    return res.status(out.ok ? 200 : 502).json(out);
  }

  // ============ PORTAL views (agents + admin, scoped to the signed-in agent) ============
  // These run BEFORE the admin gate so agents can reach them; each is strictly scoped to the caller's own email.
  const view = String(req.query.view || '');
  
/* ---------- Client search filter, shared by portal_search and our_clients ----------
   Two bugs lived here, both the same shape: the query was transformed and the data
   was not.

   1. PHONES are stored (AAA)BBB-CCCC. Stripping parens from the query alone meant
      a typed area code could never match. Measured 0/500 on real rows. Matching the
      last seven digits as BBB-CCCC scores 500/500 and keeps parentheses out of the
      PostgREST or=() filter, which would otherwise need value double-quoting.

   2. NAMES are stored split. "Samuel Rodriguez" was asked of each column on its
      own - does first_name contain the whole phrase, does last_name - and no single
      column ever holds both words. 25,615 of 25,629 people failed a First Last
      search; reversed, all 25,629 failed. Full-name search had never worked.

   For a multi-word query we seed the request with the LONGEST word (the most
   selective - "garcia" returns 536 rows, the worst common surname, against 25,638
   clients) and require the remaining words in JS. That keeps the proven or=()
   syntax rather than nesting and=(or(...),or(...)), which cannot be tested from
   here and would break search outright if the syntax were wrong.

   Single-word and phone queries are untouched and still cost 25 rows. */
const SEARCH_COLS = ['first_name', 'last_name', 'business_name', 'email'];
function buildClientSearch(q) {
  const digits = q.replace(/\D/g, '');
  const isPhone = digits.length >= 7;
  const toks = isPhone ? [] : q.split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
  const multi = toks.length > 1;
  // Longest word first: fewest rows come back, so the JS pass has least to chew on.
  const seed = multi ? toks.slice().sort((a, b) => b.length - a.length)[0] : q;
  const like = `*${seed.replace(/[,()*]/g, '')}*`;
  const ors = SEARCH_COLS.map(c => `${c}.ilike.${like}`);
  if (isPhone) {
    const t = digits.length > 10 ? digits.slice(-10) : digits;
    ors.push(`phone.ilike.*${t.slice(-7, -4)}-${t.slice(-4)}*`);
  } else {
    ors.push(`phone.ilike.${like}`);
  }
  if (/^\d+$/.test(q)) ors.unshift(`client_no.eq.${q}`);
  return { ors, multi, toks };
}
/* Every word must appear somewhere on the row. Order-independent, so "Rodriguez
   Samuel" finds the same client as "Samuel Rodriguez". */
function matchesAllTokens(row, toks) {
  const hay = [row.first_name, row.last_name, row.business_name, row.email, row.phone]
    .filter(Boolean).join(' ').toLowerCase();
  return toks.every(t => hay.includes(t.toLowerCase()));
}

/* ---------- Ops console static content ----------
   Lives in code, not in the page, so it ships only to a signed-in admin. Versioned
   with everything else, so a diff shows when it drifted. NO CREDENTIALS EVER - the
   master project file contains a GitHub token and none of that belongs here. */
const OPS_VERSIONS = { portal: 'v4.1', console: 'v6.0', charge: 'v2.37',
  carrier: 'live', master_file: '2026-09-12' };

/* ---------- Google Business Profile, live ----------
   Two scheduled Claude tasks (Tue 9:09 Spanish post, Fri 9:10 English post, both
   also answer reviews) insert one row each into gbp_runs. This reduces those rows
   to what Speedy Ops shows. Same arithmetic that ran locally on Sep 12; moved here
   so the number Saif reads on his phone is the number the task wrote. */
const GBP_BRANCHES = [
  { key: 'VanBuren',     name: 'Riverside — Van Buren', phone: '(951) 695-1500', review: 'https://g.page/r/CYRJKiQNEUAJEBE/review' },
  { key: 'Magnolia',     name: 'Riverside — Magnolia',  phone: '(951) 977-9400', review: 'https://g.page/r/Ca8NG2LfuGczEBE/review' },
  { key: 'MorenoValley', name: 'Moreno Valley',         phone: '(951) 472-0927', review: 'https://g.page/r/CRndOnckRyDfEBE/review' },
  { key: 'LakeElsinore', name: 'Lake Elsinore',         phone: '(951) 579-4095', review: 'https://maps.app.goo.gl/TavZvYkmX9LgdvsAA' },
  { key: 'Colton',       name: 'Colton',                phone: '(909) 587-6001', review: 'https://www.google.com/maps/search/?api=1&query=Speedy+Insurance+Agency+1047+N+Mt+Vernon+Ave+Colton+CA+92324' },
];
function gbpSummary(rows) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const days = d => Math.max(0, Math.round((today - new Date(d + 'T00:00:00Z')) / 864e5));
  const sum = o => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const pubCount = p => Object.values(p.published || {}).filter(Boolean).length;
  const within = n => rows.filter(r => days(r.run_date) <= n);
  const posts = rs => rs.reduce((t, r) => t + (r.posts || []).reduce((a, p) => a + pubCount(p), 0), 0);
  const branches = GBP_BRANCHES.map(b => {
    let en = null, es = null, replies30 = 0;
    for (const r of rows) {
      for (const p of r.posts || []) if (p.published && p.published[b.key]) { const x = { date: r.run_date, theme: p.theme }; if (p.lang === 'es') es = x; else en = x; }
      if (days(r.run_date) <= 30) replies30 += Number((r.replies || {})[b.key]) || 0;
    }
    const age = x => (x ? days(x.date) : null);
    return { ...b, en, es, en_age: age(en), es_age: age(es), replies30,
      stale: en == null || es == null || days(en.date) > 8 || days(es.date) > 8 };
  });
  const last = rows[rows.length - 1] || null;
  return {
    replies_30d: within(30).reduce((t, r) => t + sum(r.replies), 0),
    posts_7d: posts(within(7)),
    posts_30d: posts(within(30)),
    for_saif: rows.flatMap(r => (r.for_saif || []).map(text => ({ date: r.run_date, text }))),
    last_run: last ? { date: last.run_date, kind: last.kind, age: days(last.run_date) } : null,
    branches,
    runs: rows.slice(-10).reverse().map(r => ({ date: r.run_date, kind: r.kind, replies: sum(r.replies),
      posts: (r.posts || []).map(p => ({ theme: p.theme, lang: p.lang, n: pubCount(p), reason: p.reason || null })), notes: r.notes || '' })),
  };
}

const OPS_COSTS = { fixed_monthly: 190, lines: [
  { name: 'Vercel Pro', amount: 20 },
  { name: 'Supabase Pro', amount: 25 },
  { name: 'TurboRater for Websites', amount: 145, note: 'Zywave Q-182382 · auto-renews, 60-day notice, remind Apr 2027' },
  { name: 'Anthropic API', amount: null, note: 'usage — update monthly' },
]};

const OPS_LINKS = [
  { group: 'Live pages', items: [
    { name: 'Agent portal', url: '/admin/portal.html', note: 'v4.1' },
    { name: 'Charge page', url: '/admin/charge.html', note: 'v2.37' },
    { name: 'Platform console', url: '/admin/platform.html', note: 'v6.0 · info@ only' },
    { name: 'Carrier audit', url: '/admin/carrier.html', note: 'docs=1 for documents only' },
    { name: 'Agent ticket form', url: '/admin/ticket.html', note: 'public by design' },
    { name: 'HawkSoft API dashboard', url: '/admin/hawksoft.html' },
    { name: 'Health checks', url: '/admin/', note: 'the live monitor' },
  ]},
  { group: 'Public site', items: [
    { name: 'speedyins.com', url: 'https://www.speedyins.com' },
    { name: 'Spanish site', url: 'https://www.speedyins.com/es.html' },
    { name: 'Quote form', url: 'https://www.speedyins.com/quote.html', note: 'TurboRater' },
    { name: 'Cotizar', url: 'https://www.speedyins.com/cotizar.html' },
    { name: 'QR redirect', url: 'https://www.speedyins.com/qr', note: '307 — must stay non-permanent' },
    { name: 'Speedy Hub', url: 'https://speedy-hub.vercel.app', note: 'agent hub' },
  ]},
  { group: 'Infrastructure', items: [
    { name: 'Supabase', url: 'https://supabase.com/dashboard/project/huvpitgappdqgavrqbud' },
    { name: 'Vercel — speedy-website', url: 'https://vercel.com/speedyinsadmin-8075s-projects' },
    { name: 'Vercel — speedy-dashboard', url: 'https://vercel.com/speedyinsadmin-8075s-projects', note: 'SSO-gated' },
    { name: 'Vercel — speedy-hub', url: 'https://vercel.com/speedyinsadmin-8075s-projects' },
  ]},
  { group: 'Code', items: [
    { name: 'speedy-website', url: 'https://github.com/speedyinsadmin-alt/speedy-website', note: 'site + all APIs · PUBLIC' },
    { name: 'speedy-dashboard', url: 'https://github.com/speedyinsadmin-alt/speedy-dashboard', note: 'PUBLIC' },
    { name: 'speedy-hub', url: 'https://github.com/speedyinsadmin-alt/speedy-hub', note: 'PUBLIC' },
  ]},
  { group: 'Vendors', items: [
    { name: 'HawkSoft Partner API v4', url: 'https://partner.hawksoft.app/v4/api.html', note: 'contract 15112' },
    { name: 'Clover', url: 'https://www.clover.com/dashboard', note: 'app pending since Jul 23' },
    { name: 'RingCentral', url: 'https://service.ringcentral.com' },
    { name: 'Tawk.to', url: 'https://dashboard.tawk.to' },
    { name: 'Google Business Profile', url: 'https://business.google.com/locations' },
    { name: 'GBP reviews', url: 'https://business.google.com/reviews', note: 'all five branches, newest first' },
    { name: 'Facebook', url: 'https://www.facebook.com/speedyinsuranceagency/' },
    { name: 'Instagram', url: 'https://www.instagram.com/speedy.insurance/' },
  ]},
  { group: 'Review links — send to clients', items: GBP_BRANCHES.map(b =>
    ({ name: b.name, url: b.review, note: /g\.page/.test(b.review) ? 'opens the review box' : 'Maps link — client must find the button' })) },
];

/* Grouped the way the sidebar reads: act on it, or it is backlog, or it is
   reference. Priority is about what breaks if ignored, not about effort. */
const OPS_SECTIONS = [
  { id: 'blocking', title: 'Blocking now', items: [
    { pri: 'high', text: 'Duplicate receipts — agents re-key what the bridge already posted. Esmeralda confirmed. Ask what she sees after a charge before building anything' },
    { pri: 'med',  text: 'Roster table — steps 1–4 DONE Sep 10–11 (role/grants columns, ADDITIVE read, may(), gates on the roster, Staff page). Left: step 5 activity view over events, then delete the temporary perm_check' },
    { pri: 'high', text: 'Clover terminal has never run a live charge — pending app approval since Jul 23' },
    { pri: 'high', text: 'Golden Square Insurance — 6th verified Google profile on the old Lake Elsinore address, splitting reviews. Parked to Sep 4, OVERDUE. Close or merge, NEVER delete' },
  ]},
  { id: 'money', title: 'Money path', items: [
    { pri: 'high', text: 'Pol 1 — prove a PORTAL-launched charge files to the correct policy tab. Partially proven, waiting on a natural real charge' },
    { pri: 'med',  text: 'Merge Stage 1 — replace the policy string match in the charge path. Parked behind Pol 1' },
    { pri: 'med',  text: 'Earnings breakdown — show the charge and payment beside the commission, add search' },
    { pri: 'med',  text: 'Portal not showing open invoices — reported, not diagnosed' },
    { pri: 'low',  text: 'Merge the redundant third HawkSoft log row — each charge posts receipt + attachment + a text-only summary' },
    { pri: 'low',  text: 'Reverse the ZZTEST probe receipts (1.11 / 1.22 / 1.33 / 1.44, posted twice Sep 1)' },
  ]},
  { id: 'portal', title: 'Portal & console', items: [
    { pri: 'med',  text: 'Light mode is portal.html only — charge, carrier and console still dark' },
    { pri: 'med',  text: 'Call log by-agent view — rows are call LEGS, must group by rc_session_id' },
    { pri: 'med',  text: 'Consolidate six hardcoded staff lists — the agents table exists for this' },
    { pri: 'low',  text: 'Shared stylesheet — .hide, .btn and esc() have each been assumed to exist and were not' },
    { pri: 'low',  text: 'In a month: drop file_b64 once portal_doc reports served:storage' },
  ]},
  { id: 'security', title: 'Security', items: [
    { pri: 'high', text: 'Regenerate the Clover App Secret — exposed in chat screenshots — and update Vercel' },
    { pri: 'med',  text: 'api/hawksoft.js gates on the @speedyins.com domain only, while the other APIs use explicit allowlists. The money API is the loosest' },
    { pri: 'med',  text: 'Attorney review — California all-party consent for call recording and AI scoring' },
    { pri: 'low',  text: 'Two SECURITY DEFINER functions remain callable by anon' },
    { pri: 'low',  text: 'All three repos are PUBLIC — no secret may ever enter them' },
  ]},
  { id: 'vendors', title: 'Vendors', items: [
    { pri: 'high', text: 'Clover production app — pending since Jul 23. After approval: authorize MV, then terminal test' },
    { pri: 'med',  text: 'Per-branch Clover OAuth still needed for Van Buren, Magnolia, Lake Elsinore' },
    { pri: 'med',  text: 'IVANS — can Speedy act as a sender, pushing data into the network? Ask Brian Marable' },
    { pri: 'med',  text: 'IVANS carrier expansion — cross-match the 454-company matrix against our carriers' },
    { pri: 'low',  text: 'RingCentral AI CEB proposal — evaluate separately from the renewal decision' },
  ]},
  { id: 'website', title: 'Website & comms', items: [
    { pri: 'high', text: 'TurboRater embed — quote form is still temporarily wired to Tawk.to' },
    { pri: 'med',  text: 'Tawk.to per-branch routing — 4 widgets, switchWidget(), both index.html and es.html' },
    { pri: 'med',  text: 'SEO pass — LocalBusiness schema, sitemap.xml, robots.txt, hreflang' },
    { pri: 'med',  text: 'GA + Search Console' },
    { pri: 'low',  text: 'Google reviews section on the site' },
    { pri: 'low',  text: 'Privacy / Terms / SMS opt-in language' },
    { pri: 'low',  text: 'Sticky mobile CTA' },
  ]},
  { id: 'gbp', title: 'Google Business', items: [
    { pri: 'high', text: 'Four reviewers across 2019–2025 allege paid reviews. Breaches Google policy. ESCALATED TO TONY — business decision, not a template' },
    { pri: 'high', text: 'Golden Square — was parked to Fri Sep 4, now OVERDUE. Close or merge into Lake Elsinore, never delete or its reviews go too' },
    { pri: 'med',  text: 'Review links: Lake Elsinore is a Maps share link and Colton a Maps search — neither opens the review box. Grab the g.page short links from GBP Manager → Ask for reviews' },
    { pri: 'med',  text: 'Photos — Van Buren last upload 1,400+ days ago; nothing automated uploads photos yet. Send a folder and the Friday task can post one a week' },
    { pri: 'low',  text: 'Sep 12: posting is automated. Fri 9:10 English post + Tue 9:09 Spanish post, both answer reviews, both publish without the picker (extension file_upload into the dialog\'s hidden input). The old Cowork task (wrong Van Buren address) is deleted. Only a 1–3★ review newer than 6 months is left for Saif — it appears in the GBP block above' },
  ]},
];

const OPS_DECISIONS = [
  { who: 'Tony', text: 'Clover production app — still pending approval since Jul 23' },
  { who: 'Tony', text: 'Attorney review — California all-party consent for call recording' },
  { who: 'Tony', text: 'Platform SaaS spinout — entity, IP ownership, insurance' },
  { who: 'Tony', text: 'Paid-review allegations across four Google reviewers' },
];

/* Every one of these was a production incident. Kept on the page because the same
   shape keeps recurring and recognising it early is the only defence. */
const OPS_RECURRING = [
  'A value transformed on one side and compared against the untransformed other — phone search, full-name search, ownership by display name',
  'Something not carrying its identifier through — payment_id, policy GUID, commission_to, RefId, audit_completed_by',
  'A column nobody writes, or a value handed in and dropped — storeReceiptVault got policyGuid and never wrote it',
  'CSS classes assumed to exist because they do in a sibling file — .hide, .btn, esc()',
  'Shared STAFF maps that drift across six files',
  'Dates computed in UTC for an agency that runs on Pacific',
  'Inferring the identifying attribute from the pattern being explained — the Tendered 0.00 mistake',
];

const OPS_PLATFORM_MAP = [
  { k: 'A · Money', v: 'Clover ecommerce, cash, terminal, pay links. bridge_ledger is the record of truth' },
  { k: 'B · Clients', v: 'HawkSoft sync into clients and policies. 2am Pacific cron plus manual refresh' },
  { k: 'C · Documents', v: 'Private Supabase bucket client-documents. Dual-written with file_b64 for now' },
  { k: 'D · Operations', v: 'Portal, charge sheet, carrier audit, console, notifications, commission' },
  { k: 'E · Compliance', v: 'Audit trail in events. CCPA. Call recording pending attorney review' },
];

const portalViews = ['portal_home', 'portal_search', 'portal_client', 'portal_thumbs', 'portal_doc', 'portal_staff', 'portal_news', 'portal_share_due', 'portal_refresh_clients'];
  if (portalViews.includes(view)) {
    const who = await verifyPortal(req.headers['x-id-token']);
    /* Declared HERE, at the top of the portal block. portal_share_due and portal_news
       both use `me`, and it only ever existed inside portal_home's own if-block - so
       both have thrown ReferenceError since 2026-08-14, 169 times across 3 agents.
       That is why the notification bell never appeared for anyone, and why the share
       prompt never asked an owner about sharing. Lowercased once: every comparison
       against it is an email identity check. */
    const me = String((who && who.email) || '').toLowerCase();
    if (!who) return res.status(401).json({ ok: false, error: 'Not authorized' });
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });

    if (view === 'portal_search') {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(200).json({ ok: true, results: [] });
      const { ors, multi, toks } = buildClientSearch(q);
      /* A multi-word query over-fetches so the second word can be applied in JS.
         800 covers the worst common surname (garcia, 536) with headroom; the select
         is six short text columns, so this is tens of KB, not a document load. */
      const cl = await sbGet(s, `clients?select=client_no,first_name,last_name,business_name,email,phone,branch&or=(${ors.join(',')})&order=client_no.asc&limit=${multi ? 800 : 25}`);
      let rows = cl.rows || [];
      if (multi) rows = rows.filter(c => matchesAllTokens(c, toks)).slice(0, 25);
      const results = rows.map(c => ({
        client_no: c.client_no,
        name: c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' '),
        phone: c.phone || null, branch: c.branch || null,
      }));
      return res.status(200).json({ ok: true, results });
    }

    if (view === 'portal_refresh_clients') {
      /* "Refresh client list" — the escape hatch when an agent has just created a
         client in HawkSoft and cannot find them yet. Search reads OUR clients table,
         which the cron fills at 09:00 UTC (2am Pacific), so a client added during the
         day was invisible until the next night. HawkSoft has no webhooks; polling is
         the only model they offer.

         Two guards, because thirteen agents share this button:
         - cooldown lives in the DATABASE, not memory. Vercel runs many function
           instances, so an in-process guard would not hold across them.
         - a short budget. The cron can grind for four minutes; nobody waits that long
           for a button. A run that does not finish simply leaves the watermark alone
           and gets picked up next time, so stopping early is always safe. */
      const COOLDOWN_MS = 60000;
      const st = await sbGet(s, 'sync_state?key=eq.hawksoft_clients&select=last_sync');
      const last = st.rows && st.rows[0] && st.rows[0].last_sync;
      if (last && (Date.now() - new Date(last).getTime()) < COOLDOWN_MS) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'cooldown',
          seconds_ago: Math.round((Date.now() - new Date(last).getTime()) / 1000) });
      }
      const out = await runDeltaSync(s, who.email, 25000);
      if (!out.ok) return res.status(200).json({ ok: false, error: out.error || 'sync failed' });
      return res.status(200).json({ ok: true, changed: out.changed, clients: out.clients,
        policies: out.policies, partial: out.partial });
    }

    if (view === 'portal_staff') {
      /* ITEM 22, THE REST OF IT. This list existed FOUR times: portal.html's own STAFF
         map, charge.html's copy of it, AGENT_NAME here, and the agents table. A branch
         Tony set on the Staff page reached none of them, so the page he was given to
         manage offices had no effect on the office an agent signs in under. This view
         is now the one the portal reads for all three of those things — who I am, what
         my home branch is, and who can be handed a commission.

         ADDITIVE, exactly like rosterAgents(): AGENT_NAME is the floor and the table
         only ever ADDS or RENAMES. A failed roster read therefore returns the same
         list the page got before this change, never an empty commission dropdown.
         Aug 30's lesson applied to a money control rather than to a gate. */
      const roster = await loadRoster();
      const byEmail = new Map();
      for (const [email, name] of Object.entries(AGENT_NAME)) {
        byEmail.set(email.toLowerCase(), { email: email.toLowerCase(), name, active: true });
      }
      for (const a of roster.values()) {
        if (a.external) continue;              // the table may only ever add @speedyins.com
        const prev = byEmail.get(a.email);
        byEmail.set(a.email, {
          email: a.email,
          name: a.name || (prev && prev.name) || a.email.split('@')[0],
          /* active gates who may be OFFERED a commission. Inactive people are still
             returned, because a departed agent's name has to render on the payments
             they already wrote — the same rule loadRoster follows. */
          active: a.active === true,
        });
      }
      const mine = roster.get(me) || null;
      return res.status(200).json({ ok: true,
        staff: [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name)),
        producers: PRODUCER_MAP,
        /* The five offices, from the same constant the Staff page's dropdown uses, so
           a branch set there is always one this picker can pre-select. */
        branches: OFFICE_NAMES,
        /* WHO IS SIGNED IN. `known` says the table has a row for them at all; `branch`
           is null when it has one with no branch set. The page must treat those the
           same way — show the picker, pre-select nothing — because guessing a branch
           stamps a real office onto a real payment. */
        me: {
          email: me,
          known: !!mine,
          name: (mine && mine.name) || AGENT_NAME[me] || null,
          branch: (mine && mine.branch) || null,
          producer_code: (mine && mine.producer_code) || null,
          role: (mine && mine.role) || (who.role === 'admin' ? 'admin' : 'agent'),
        },
      });
    }

if (view === 'portal_share_due') {
      /* Completed audits where this agent owns the commission, somebody else ran the
         charge, and no share decision has been made. Asked at completion because that
         is the first moment the fee — and so the commission — is a real number. */
      const r = await sbGet(s, `bridge_ledger?commission_to=eq.${encodeURIComponent(me)}`
        + `&audit_status=eq.complete&share_locked_at=is.null&is_test=is.false`
        + `&select=id,ts,client_id,amount,agent,fee_amount,audit_completed_by&order=ts.desc&limit=10`);
      const rate = await sbGet(s, `agent_commission?agent_email=eq.${encodeURIComponent(me)}&select=percentage`);
      const pct = (rate.rows && rate.rows[0]) ? Number(rate.rows[0].percentage) : 10;
      /* Two ways somebody can have worked on a payment they do not earn: they RAN
         the charge, or they FINISHED the audit. Only the first was ever considered,
         so an agent who did the finishing was invisible to the share flow. Prefer
         the auditor when both exist - completing the audit is the harder half and
         is the step being opened up to helpers. */
      const helperOf = x => {
        const auditor = agentEmailOf(x.audit_completed_by);
        if (auditor && auditor !== me) return { email: auditor, why: 'finished the audit' };
        const charger = agentEmailOf(x.agent);
        if (charger && charger !== me) return { email: charger, why: 'ran this charge' };
        return null;
      };
      const due = (r.rows || [])
        .map(x => ({ x, h: helperOf(x) }))
        .filter(({ x, h }) => h && x.fee_amount != null)
        .map(({ x, h }) => ({ id: x.id, ts: x.ts, client_no: x.client_id, amount: Number(x.amount),
          fee: Number(x.fee_amount), commission: +(Number(x.fee_amount) * pct / 100).toFixed(2),
          helper_email: h.email, helper_why: h.why,
          helper_name: AGENT_NAME[h.email] || h.email }));
      return res.status(200).json({ ok: true, rate: pct, due });
    }

    if (view === 'portal_news') {
      /* Notifications, built from the events we already write. Nothing new is stored
         except a "last seen" marker per agent, so this stays cheap. */
      // NOTE: kind values contain dots. PostgREST treats "." as a separator inside
      // in.(), so each value must be double-quoted or the filter matches nothing.
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const ev = await sbGet(s, `events?ts=gte.${since}`
        + `&kind=in.("commission.reassigned","commission.shared","audit.repaired","client.corrected","client.correction_rejected","audit.submitted_by_other","audit.sent_back","audit.approved","refund.decided")`
        + `&select=id,ts,actor,kind,client_no,payload&order=ts.desc&limit=100`);

      const seenRow = await sbGet(s, `agent_prefs?agent_email=eq.${encodeURIComponent(me)}&select=news_seen_at`);
      const seenAt = (seenRow.rows && seenRow.rows[0]) ? seenRow.rows[0].news_seen_at : null;

      const nameOf = e => AGENT_NAME[e] || (e ? String(e).split('@')[0] : 'someone');
      const items = [];
      for (const e of (ev.rows || [])) {
        const p = e.payload || {};
        const actor = agentEmailOf(e.actor);
        if (e.kind === 'commission.reassigned') {
          if (p.to === me && actor !== me) {
            items.push({ id: e.id, ts: e.ts, tone: 'amber', client_no: e.client_no,
              title: nameOf(actor) + ' gave you a payment',
              detail: '$' + Number(p.amount || 0).toFixed(2) + ' — they charged it, you earn it',
              action: 'Needs your proof of payment' });
          } else if (p.from === me && actor !== me) {
            items.push({ id: e.id, ts: e.ts, tone: 'grey', client_no: e.client_no,
              title: nameOf(actor) + ' moved a payment off your list',
              detail: '$' + Number(p.amount || 0).toFixed(2) + ' now belongs to ' + nameOf(p.to) });
          }
        } else if (e.kind === 'audit.submitted_by_other' && p.owner === me && actor !== me) {
          items.push({ id: e.id, ts: e.ts, tone: 'green', client_no: e.client_no,
            title: nameOf(actor) + ' submitted an audit for you',
            detail: '$' + Number(p.amount || 0).toFixed(2)
              + (p.carrier ? ' — ' + p.carrier : '')
              + (p.carrier_amount != null ? ', carrier cost $' + Number(p.carrier_amount).toFixed(2) : ''),
            action: 'Check it — your commission is worked out from that cost, once it is approved' });
        } else if (e.kind === 'audit.sent_back' && (p.owner === me || p.submitted_by === me)) {
          /* The one thing the review leaves for the agent. Loud, with the reason verbatim. */
          items.push({ id: e.id, ts: e.ts, tone: 'red', client_no: e.client_no, payment_id: p.payment_id,
            title: nameOf(actor) + ' sent back your audit',
            detail: (p.code_label || 'Needs a fix') + ': “' + (p.reason || '') + '” — $' + Number(p.amount || 0).toFixed(2) + ' on client #' + e.client_no,
            action: 'Fix it and resubmit — nothing is earned on this one until it is approved' });
        } else if (e.kind === 'audit.approved' && (p.owner === me || p.submitted_by === me) && actor !== me) {
          items.push({ id: e.id, ts: e.ts, tone: 'green', client_no: e.client_no, payment_id: p.payment_id,
            title: nameOf(actor) + ' approved your audit',
            detail: '$' + Number(p.amount || 0).toFixed(2) + ' on client #' + e.client_no
              + (p.fee != null ? ' — fee $' + Number(p.fee).toFixed(2) : '')
              + (p.after_sendback ? ' (after a send-back)' : ''),
            action: 'Commission earned this month.' });
        } else if (e.kind === 'commission.shared' && p.helper === me) {
          items.push({ id: e.id, ts: e.ts, tone: 'green', client_no: e.client_no,
            title: nameOf(p.owner) + ' shared commission with you',
            detail: p.pct + '% of $' + Number(p.fee || 0).toFixed(2) });
        } else if (e.kind === 'client.corrected') {
          // tell whoever asked for it, once someone else acted on it
          if ((p.requested_by === me || p.owner === me) && actor !== me) {
            items.push({ id: e.id, ts: e.ts, tone: 'green', client_no: p.to,
              title: 'Your wrong-client correction was approved',
              detail: '$' + Number(p.amount || 0).toFixed(2) + ' moved from #' + p.from + ' to #' + p.to,
              action: 'Back in your list — it still needs proof' });
          }
        } else if (e.kind === 'client.correction_rejected') {
          if (p.requested_by === me) {
            items.push({ id: e.id, ts: e.ts, tone: 'amber', client_no: e.client_no,
              title: 'Your wrong-client correction was not approved',
              detail: 'The payment stays on client #' + e.client_no });
          }
        } else if (e.kind === 'refund.decided' && p.requested_by === me) {
          items.push({ id: e.id, ts: e.ts, tone: p.approved ? 'green' : 'amber', client_no: e.client_no,
            title: p.approved ? 'Your refund request was approved' : 'Your refund request was not approved',
            detail: '$' + Number(p.amount || 0).toFixed(2) + ' on client #' + e.client_no
              + (p.note ? ' — ' + p.note : ''),
            action: p.approved ? 'The refund has been issued and the client told.' : 'The payment stands as it was.' });
        } else if (e.kind === 'audit.repaired' && p.entered_by === me) {
          items.push({ id: e.id, ts: e.ts, tone: 'green', client_no: e.client_no,
            title: 'An audit was repaired for you',
            detail: p.carrier + ' $' + Number(p.carrier_amount || 0).toFixed(2) + ' — fee $' + Number(p.fee || 0).toFixed(2) });
        }
      }
      const unread = seenAt ? items.filter(i => i.ts > seenAt).length : items.length;
      return res.status(200).json({ ok: true, unread, items: items.slice(0, 25), seen_at: seenAt });
    }

    if (view === 'portal_thumbs') {
      // Thumbnails for ONE client's documents — small images only, never full files.
      const no = String(req.query.no || '').replace(/\D/g, '');
      if (!no) return res.status(400).json({ ok: false, error: 'client no required' });
      const r = await sbGet(s, `attachments?client_no=eq.${no}&select=id,thumb_b64`);
      return res.status(200).json({ ok: true, thumbs: (r.rows || []).filter(x => x.thumb_b64) });
    }

    if (view === 'portal_doc') {
      /* One document's bytes, on demand.
         SECURITY: `blob_url` holds a PATH inside the PRIVATE client-documents
         bucket, not a public URL, and it is never sent to the browser. This
         function is the only door, and it already sits behind Google SSO plus the
         agent allowlist. Signed URLs were deliberately not used: once minted they
         work for anyone holding them until they expire, which is a weaker gate
         than the one we already have. */
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await sbGet(s, `attachments?id=eq.${encodeURIComponent(id)}&select=filename,mime,file_b64,blob_url`);
      const row = (r.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });

      /* Storage first, Postgres second. During the dual-write period both exist;
         reading storage is what proves the path works before the inline copy is
         dropped. A storage miss falls back silently - the agent still gets the file. */
      let file_b64 = row.file_b64 || null, served = row.file_b64 ? 'inline' : 'none';
      if (row.blob_url) {
        const got = await storageGet(row.blob_url);
        if (got) { file_b64 = got; served = 'storage'; }
      }
      if (!file_b64) return res.status(404).json({ ok: false, error: 'no bytes stored' });
      return res.status(200).json({ ok: true, filename: row.filename, mime: row.mime, file_b64, served });
    }

    if (view === 'portal_client') {
      const no = String(req.query.no || '').replace(/\D/g, '');
      if (!no) return res.status(400).json({ ok: false, error: 'client no required' });
      const cl = await sbGet(s, `clients?client_no=eq.${no}&select=*`);
      const client = (cl.rows || [])[0];
      if (!client) return res.status(404).json({ ok: false, error: 'not found' });
      const po = await sbGet(s, `policies?client_no=eq.${no}&select=*&order=expiration_date.desc`);
      // Full payment history + document METADATA. Deliberately no file_b64 and no
      // thumb_b64 here: bytes are fetched only when a document is opened.
      /* ITEM 84. Test rows are hidden from every real client card, as they should be —
         but that made ZZTEST itself unreachable: its payments are all is_test, so the
         one client that exists for trying things on showed an empty card, and the new
         Refund button could never be exercised end to end before it met a real client.
         ON ZZTEST ONLY, and only for an admin, the filter is dropped. A real client's
         card never shows a test row. */
      /* rosterAdmins(), not the code list: Tony is an owner via the TABLE and is not in
         ADMIN_ALLOWLIST, so the code list said he was not an admin. Item 70's rule. */
      const isAdminHere = (await rosterAdmins()).has(me);
      const showTest = (Number(no) === TEST_CLIENT && isAdminHere);
      const pay = await sbGet(s, `bridge_ledger?client_id=eq.${no}${showTest ? '' : '&is_test=is.false'}&select=id,ts,amount,purpose,audit_status,kind,ref,agent,fee_amount,service_cost,carrier_name,commission_to,producer_code,total_owed,balance_of,refund_of,refund_reason,refund_carrier,refund_note,extra,is_test,audit_submitted_by,audit_submitted_at,audit_sendback,audit_completed_by,audit_completed_at,policy_number:extra->>policyNumber,policy_guid:extra->>policyGuid&order=ts.desc&limit=50`);
      /* uploaded_by: any agent may now add documents to any payment, so the chip has
         to say who did. Short text column — no meaningful payload cost. */
      const docs = await sbGet(s, `attachments?client_no=eq.${no}&select=id,payment_id,kind,doc_type,filename,bytes,mime,created_at,filed_hawksoft,uploaded_by&order=created_at.desc&limit=200`);
      /* Open refund requests on this client, so the card can say "waiting for Tony"
         instead of offering the button again. */
      const rqs = await sbGet(s, `refund_requests?client_id=eq.${no}&status=eq.pending&select=id,payment_id,requested_by,requested_at,amount,reason`);
      const rqBy = Object.fromEntries((rqs.rows || []).map(r => [r.payment_id, r]));
      return res.status(200).json({
        ok: true, client, policies: po.rows || [],
        recent: (pay.rows || []).slice(0, 6),
        payments: (pay.rows || []).map(r => ({
          id: r.id, ts: r.ts, amount: r.amount, purpose: r.purpose, audit_status: r.audit_status,
          kind: r.kind, ref: r.ref,
          total_owed: r.total_owed != null ? Number(r.total_owed) : null,
          collected: collectedFor(r, pay.rows || []),
          charged_by: AGENT_NAME[agentEmailOf(r.agent)] || agentEmailOf(r.agent) || null,
          /* The EMAIL as well as the display name. The card decided ownership by
             testing whether the display name contained the signed-in email's local
             part - "tony dabouqi".includes("info") is false, so info@ got no button
             on a payment it had just taken. lfigueroa@ / "Laura Figueroa" fails the
             same way. The other fifteen agents passed by coincidence. Compare
             identifiers, never rendered text. */
          charged_by_email: agentEmailOf(r.agent) || null,
          commission_to: r.commission_to || agentEmailOf(r.agent) || null,
          commission_to_name: AGENT_NAME[r.commission_to || agentEmailOf(r.agent)] || null,
          carrier_name: r.carrier_name, service_cost: r.service_cost, fee_amount: r.fee_amount,
          /* The column was SELECTED above and then dropped here, so the card could not
             tell a balance payment from a normal one: it wore a "needs proof" chip and
             offered "Add proof of payment" on a row that carries no audit of its own.
             Auditing one writes a fee onto it — and the Trust tab reads fee_amount with
             no audit_status filter (:2088), so that fee lands straight in "Speedy kept".
             portal_home has always skipped these rows (:1152); the card never could. */
          balance_of: r.balance_of || null,
          /* WHAT THE CARD NEEDS TO TELL THE TRUTH ABOUT A REFUND.
             `refund_of` marks the row itself as a refund; `refunded` says how much has
             come off a PAYMENT. Without the second one the card would show a payment
             at its original amount with a refund sitting somewhere below it and no
             connection between them — which is how the balance payments read before
             item 76, and Saif had to ask what the $34 line was. */
          refund_of: r.refund_of || null,
          refund_reason: r.refund_reason || null,
          refund_carrier: r.refund_carrier || null,
          refund_note: r.refund_note || null,
          refunded: +Math.abs((pay.rows || [])
            .filter(x => x.refund_of === r.id)
            .reduce((a, x) => a + Number(x.amount || 0), 0)).toFixed(2),
          /* WAS THE CLIENT TOLD. One shape for charges and refunds. Measured before this
             existed: of the last 60 real charges, 19 had "no client email on file" —
             recorded on the row, shown nowhere, so the agent saw a green screen and the
             client got nothing. null means the row predates any record, and the card
             says so rather than showing a blank. */
          client_notice: clientNoticeOf(r),
          is_test: r.is_test === true,
          /* THE REVIEW, as the agent sees it: who submitted, the last send-back with its
             reason (kept on the row for good), who approved. Names resolved here so the
             card never shows a bare email. */
          audit_submitted_by: r.audit_submitted_by || null,
          audit_submitted_by_name: r.audit_submitted_by ? (AGENT_NAME[r.audit_submitted_by] || r.audit_submitted_by) : null,
          audit_submitted_at: r.audit_submitted_at || null,
          audit_sendback: r.audit_sendback ? { ...r.audit_sendback, by_name: AGENT_NAME[r.audit_sendback.by] || r.audit_sendback.by } : null,
          audit_completed_by: r.audit_completed_by || null,
          audit_completed_by_name: r.audit_completed_by ? (AGENT_NAME[r.audit_completed_by] || r.audit_completed_by) : null,
          audit_completed_at: r.audit_completed_at || null,
          refund_request: rqBy[r.id] ? { id: rqBy[r.id].id, requested_by: rqBy[r.id].requested_by,
            requested_by_name: AGENT_NAME[rqBy[r.id].requested_by] || rqBy[r.id].requested_by,
            requested_at: rqBy[r.id].requested_at, amount: Number(rqBy[r.id].amount), reason: rqBy[r.id].reason } : null,
          // NOTE: no commission figures here — the client log is shared with every agent
        })),
        /* The card gated its correction links on "I earn it or I took it", so an ADMIN
           opening someone else's payment saw no links at all — while the server has
           always allowed admin on move_client, reassign_commission and now
           link_balance. The gate and the offer disagreed, which meant the one person
           who is supposed to be able to fix anything could not reach the controls.
           Told by the SERVER rather than comparing an email in the browser: the
           allowlist is server-side and an identity from a browser is a claim. */
        /* Was ADMIN_ALLOWLIST.includes(me) — the CODE list — which told the card that
           Tony, an owner via the table, was not an admin, so he saw no correction links
           on anyone's payment. Found by the refund harness signing in as tony@. */
        is_admin: isAdminHere,
        /* Told by the SERVER, from may(), for the same reason is_admin is: an identity
           compared in the browser is a claim, and the Refund button must appear only
           for someone the server would actually let refund. This is the permission
           Tony grants on the Staff page, not a hardcoded address — hardcoding info@
           here would have been the fifth place to change later. */
        can_refund: await may(me, 'refund'),
        /* What the refund sheet offers as "on the record". The synced email plus any
           extras HawkSoft carried. The server re-checks an on_file claim against the
           same list, so the sheet cannot offer an address the server would refuse. */
        contact: { emails: [client.email, ...(((client.extras || {}).emails) || [])]
          .filter(Boolean).map(e => String(e).trim()).filter((e, i, a) => a.indexOf(e) === i) },
        producer_code: client && client.extras ? (client.extras.producer || null) : null,
        producer_name: client && client.extras ? (AGENT_NAME[PRODUCER_MAP[client.extras.producer]] || null) : null,
        documents: docs.rows || [],
      });
    }

    if (view === 'portal_home') {
      /* `me` comes from the top of the portal block. */
      // Pull this agent's own ledger rows (match any agent string containing their email)
      /* audit_completed_by and audit_completed_at were BOTH missing from this
         select while the code below read them - finished_by was silently undefined
         on every line since it shipped. The period test now depends on
         audit_completed_at, so a missing column here would put every payment in the
         wrong month rather than just dropping a name. */
      const all = await sbGet(s, 'bridge_ledger?is_test=is.false&select=id,ts,client_id,amount,purpose,agent,audit_status,fee_amount,service_cost,txn_id,kind,extra,commission_to,helper_email,helper_share_pct,correction_status,total_owed,balance_of,audit_completed_by,audit_completed_at,audit_submitted_at,audit_sendback&order=ts.desc&limit=500');
      const AUDIT_CUTOFF = '2026-07-29';
      const rate = await sbGet(s, `agent_commission?agent_email=eq.${encodeURIComponent(me)}&select=percentage`);
      const pct = (rate.rows && rate.rows[0]) ? Number(rate.rows[0].percentage) : 10;

      const mine = (all.rows || []).filter(r => owns(r, me) || String(r.agent || '').toLowerCase().includes(me));
      // month boundary (America/Los_Angeles approx via UTC month is fine for display)
      const now = new Date();
      /* PACIFIC month boundary, not UTC. Computed in UTC this flipped to the next
         month at 5pm Pacific on the last day, so every agent's earnings read $0.00
         for a full 24 hours every month while they were still working. Sammy hit it
         with 50 completed August payments and $9,496.23 of fees behind the boundary.
         Same class as the Console v6.0 date bug: en-CA gives YYYY-MM-DD, and the
         offset is derived rather than hardcoded so DST needs no maintenance. */
      const pacificParts = d => {
        const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        const [y, m, dd] = s.split('-').map(Number);
        return { y, m, d: dd };
      };
      /* Midnight Pacific on a given y-m-d, as a UTC instant. The offset is MEASURED
         for that date, not guessed: midday UTC is the same calendar day worldwide, so
         formatting it in Pacific and subtracting gives 7 for PDT and 8 for PST.
         An earlier version compared only the DATE after a PST guess, which passed for
         PDT dates too - 08:00 UTC is 1am PDT, still the right day, wrong hour. */
      const pacificOffset = (y, m, dd) => {
        const probe = new Date(Date.UTC(y, m - 1, dd, 12, 0, 0));
        const hh = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
          hour: '2-digit', hour12: false }).format(probe));
        return 12 - hh;
      };
      const pacificMidnightUTC = (y, m, dd) =>
        new Date(Date.UTC(y, m - 1, dd, pacificOffset(y, m, dd), 0, 0)).toISOString();
      /* period=this|last|YYYY-MM-DD:YYYY-MM-DD. Defaults to the current Pacific
         month, so nothing changes for an agent who never touches the picker. */
      const periodBounds = (raw) => {
        const t = pacificParts(now);
        const q = String(raw || 'this');
        const range = q.match(/^(\d{4})-(\d{2})-(\d{2}):(\d{4})-(\d{2})-(\d{2})$/);
        if (range) {
          const [, y1, m1, d1, y2, m2, d2] = range.map(Number);
          const endNext = new Date(Date.UTC(y2, m2 - 1, d2 + 1));
          return { from: pacificMidnightUTC(y1, m1, d1),
                   to: pacificMidnightUTC(endNext.getUTCFullYear(), endNext.getUTCMonth() + 1, endNext.getUTCDate()),
                   label: `${y1}-${String(m1).padStart(2,'0')}-${String(d1).padStart(2,'0')} to ${y2}-${String(m2).padStart(2,'0')}-${String(d2).padStart(2,'0')}` };
        }
        if (q === 'last') {
          const ly = t.m === 1 ? t.y - 1 : t.y, lm = t.m === 1 ? 12 : t.m - 1;
          return { from: pacificMidnightUTC(ly, lm, 1),
                   to: pacificMidnightUTC(t.y, t.m, 1),
                   label: `${ly}-${String(lm).padStart(2,'0')}` };
        }
        return { from: pacificMidnightUTC(t.y, t.m, 1), to: null,
                 label: `${t.y}-${String(t.m).padStart(2,'0')}` };
      };
      const period = periodBounds(req.query.period);
      /* WHICH DATE DECIDES THE MONTH. Tony's rule, Sep 1: commission is earned in the
         month the audit is APPROVED, not the month the payment was charged. A month
         that has closed can then never move afterwards.

         Historical rows were backfilled from their carrier_leg.completed event - 116
         of 116, none approved before it was charged. Four cross a month boundary and
         are the cases this rule exists for.

         Falls back to the charge date only if a completed row somehow has no approval
         time, so a payment can never silently vanish from every period. */
      const earnedAt = r => r.audit_completed_at || r.ts;
      const monthStart = period.from;
      /* An explicit end for last month and custom ranges; open-ended for the current
         one so a charge taken a minute ago still counts. */
      const inPeriod = ts => ts >= monthStart && (!period.to || ts < period.to);

      const NON_PAYMENT = ['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'];
      /* The lines BEHIND the two numbers. portal_home already walks every
         qualifying row to produce `earned` and `pending`; it just never returned
         what it walked, so an agent saw a total with nothing to check it against.
         No new query - these are filled inside the existing loop. */
      let earned = 0, pending = 0, unfinished = [], earned_lines = [];
      /* Work this agent did on somebody else's payment. Two ways: they RAN the
         charge, or they FINISHED the audit. Usually it pays them nothing - the
         owner earns it unless they chose to share - and that is exactly why it
         should be visible. Effort with no trace looks like effort nobody noticed. */
      let helped_lines = [];
      for (const r of mine) {
        const dateStr = String(r.ts || '').slice(0, 10);
        if (dateStr < AUDIT_CUTOFF) continue; // pre-audit: no commission expected
        // no money received => never ask an agent for proof, never count commission
        if (NON_PAYMENT.includes(r.audit_status)) continue;
        if (r.correction_status === 'pending') continue;  // waiting on Tony — nobody should work it
        if (r.balance_of) continue;   // pays down an earlier charge; that one carries the audit
        /* ⚠️ NOT /refund/ ANY MORE, and this is the whole reason a refund reduces
           commission at all. The old regex matched `charge_refund`, so the refund row's
           NEGATIVE fee was skipped and the reversal never happened — the exact trap
           MASTER.md recorded as "must be designed, not inherited". A declined or voided
           attempt still never moved money and is still skipped. */
        if (/declin|fail|void/i.test(String(r.kind || ''))) continue;
        const fee = r.fee_amount != null ? Number(r.fee_amount)
          : (r.service_cost != null ? Number(r.amount) - Number(r.service_cost) : null);
        const isOwner = owns(r, me);
        const complete = r.audit_status === 'complete';
        if (complete && fee != null) {
          // only the commission owner earns; a helper who ran the charge earns nothing
          // unless the owner shared, which is applied below
          const ratio = collectedRatio(r, all.rows || []);
          const full = fee * pct / 100;
          if (isOwner && inPeriod(earnedAt(r))) {
            const share = Number(r.helper_share_pct || 0);
            earned  += full * ratio * (1 - share / 100);
            pending += full * (1 - ratio) * (1 - share / 100);   // waiting on the balance
          }
          if (!isOwner && r.helper_email === me && inPeriod(earnedAt(r))) {
            const share = Number(r.helper_share_pct || 0) / 100;
            earned  += full * ratio * share;
            pending += full * (1 - ratio) * share;
          }
          if (isOwner && inPeriod(earnedAt(r))) {
            const share = Number(r.helper_share_pct || 0);
            earned_lines.push({
              id: r.id, ts: r.ts, client_no: r.client_id,
              /* Both dates. An agent seeing August work in a September total will ask
                 why, and the answer should be on the line rather than in a message. */
              approved_at: r.audit_completed_at || null,
              amount: Number(r.amount),
              carrier: r.carrier_name || null,
              carrier_cost: r.service_cost != null ? Number(r.service_cost) : null,
              fee: fee,
              commission: +(full * ratio * (1 - share / 100)).toFixed(2),
              collected_ratio: ratio,
              shared_pct: share || 0,
              /* Who did the work, when it was not the owner. Reads the column that
                 only started being written today. */
              finished_by: agentEmailOf(r.audit_completed_by) && agentEmailOf(r.audit_completed_by) !== me
                ? (AGENT_NAME[agentEmailOf(r.audit_completed_by)] || agentEmailOf(r.audit_completed_by)) : null,
              charged_by: agentEmailOf(r.agent) !== me
                ? (AGENT_NAME[agentEmailOf(r.agent)] || agentEmailOf(r.agent)) : null,
            });
          }
          if (!isOwner && inPeriod(earnedAt(r))) {
            const iCharged = agentEmailOf(r.agent) === me;
            const iFinished = agentEmailOf(r.audit_completed_by) === me;
            if (iCharged || iFinished) {
              const share = Number(r.helper_share_pct || 0);
              const ownerEmail = r.commission_to || agentEmailOf(r.agent);
              helped_lines.push({
                id: r.id, ts: r.ts, client_no: r.client_id,
                amount: Number(r.amount),
                carrier: r.carrier_name || null,
                what: iFinished ? (iCharged ? 'charged it and finished the audit' : 'finished the audit')
                                : 'ran the charge',
                owner_name: AGENT_NAME[ownerEmail] || (ownerEmail || '').split('@')[0],
                /* Only a share they were actually given. No fee, no commission -
                   somebody else's money stays somebody else's. */
                your_share: (r.helper_email === me && share)
                  ? +(full * ratio * (share / 100)).toFixed(2) : 0,
              });
            }
          }
        } else if (r.kind !== 'charge_captured' || r.audit_status) {
          // needs proof of payment / audit
          const feeGuess = fee != null ? fee * pct / 100 : null;
          if (isOwner && inPeriod(earnedAt(r)) && feeGuess != null) pending += feeGuess;
          unfinished.push({ id: r.id, ts: r.ts, client_no: r.client_id, amount: Number(r.amount),
            purpose: r.purpose, audit_status: r.audit_status || 'client_paid',
            /* waiting for an approver, or sent back with a reason - the home list says
               which, so "unfinished" never hides a row the agent cannot act on, or one
               they must. */
            audit_submitted_at: r.audit_submitted_at || null,
            audit_sendback: r.audit_sendback ? { ...r.audit_sendback, by_name: AGENT_NAME[r.audit_sendback.by] || r.audit_sendback.by } : null,
            mine: isOwner,
            charged_by: AGENT_NAME[agentEmailOf(r.agent)] || agentEmailOf(r.agent) || null,
            owner_name: AGENT_NAME[r.commission_to] || r.commission_to || null,
            owner_email: r.commission_to || agentEmailOf(r.agent) || null,
            _name: (r.extra && r.extra.clientName) || null, _policy: (r.extra && r.extra.policyNumber) || null, _guid: (r.extra && r.extra.policyGuid) || null });
        }
      }
      // client names for the unfinished list
      const ids = [...new Set(unfinished.map(u => u.client_no).filter(Boolean))];
      const nameMap = {};
      if (ids.length) {
        const cl = await sbGet(s, `clients?client_no=in.(${ids.join(',')})&select=client_no,first_name,last_name,business_name`);
        for (const c of (cl.rows || [])) nameMap[c.client_no] = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
      }
      unfinished = unfinished.map(u => ({ ...u, client_name: nameMap[u.client_no] || u._name || null, policy_number: u._policy || null, policy_guid: u._guid || null })).slice(0, 50);

      return res.status(200).json({
        ok: true, email: me, role: who.role,
        commission: { rate: pct, earned_month: +earned.toFixed(2), pending_month: +pending.toFixed(2) },
        period: period.label, period_from: monthStart, period_to: period.to,
        unfinished_count: unfinished.length, unfinished,
        earned_lines: earned_lines.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 60),
        helped_lines: helped_lines.sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 40),
        /* Open audits belonging to OTHER agents that this one could help finish.
           Built from `all`, which is already in memory - no extra query. Deliberately
           carries NO money: no fee, no service_cost, no commission. Everyone sees
           everything except commission, and a helper has no business knowing what
           somebody else earns on a payment they are only adding paperwork to.
           Capped at 20 so a backlog stays a list rather than a wall. */
        help_open: (all.rows || [])
          .filter(r => {
            if (String(r.ts || '').slice(0, 10) < AUDIT_CUTOFF) return false;
            if (r.audit_status === 'complete') return false;
            if (r.audit_status === 'ready_for_audit') return false;   // submitted: nothing left to help with
            if (NON_PAYMENT.includes(r.audit_status)) return false;
            if (r.correction_status === 'pending') return false;
            if (r.balance_of) return false;
            if (/declin|fail|void|refund/i.test(String(r.kind || ''))) return false;
            const owner = r.commission_to || agentEmailOf(r.agent);
            if (!owner || owner === me) return false;            // theirs, not help
            return agentEmailOf(r.agent) !== me;                 // already in their own list
          })
          .slice(0, 20)
          .map(r => ({ id: r.id, ts: r.ts, client_no: r.client_id, amount: Number(r.amount),
            purpose: r.purpose, audit_status: r.audit_status || 'client_paid',
            owner_email: r.commission_to || agentEmailOf(r.agent),
            owner_name: AGENT_NAME[r.commission_to || agentEmailOf(r.agent)]
              || (r.commission_to || agentEmailOf(r.agent) || '').split('@')[0] })),
        recent: mine.slice(0, 10).map(r => ({ ts: r.ts, client_no: r.client_id, amount: Number(r.amount), purpose: r.purpose, audit_status: r.audit_status || 'client_paid' })),
      });
    }
  }

  // Agent-reachable POST actions (each enforces its own scoping below)
  /* link_balance/unlink_balance are agent-reachable for the same reason move_client is:
     the agent who took the payment is the one who knows it was a balance payment, and
     every refusal below leaves the row exactly as it stands. */
  /* refund_payment is reachable so an agent gets the handler's explanation — "Tony
     can, and he can give you the permission on the Staff page" — instead of a bare
     401 that reads like a bug. may(email,'refund') is the gate, not this list. */
  const AGENT_ACTIONS = ['reassign_commission', 'news_seen', 'set_share', 'move_client',
                         'link_balance', 'unlink_balance', 'refund_payment', 'request_refund'];
  const bodyAction = (req.method === 'POST' && req.body && req.body.action) ? String(req.body.action) : '';
  let email = await verifyGoogle(req.headers['x-id-token']);
  if (!email && AGENT_ACTIONS.includes(bodyAction)) {
    const who = await verifyPortal(req.headers['x-id-token']);
    if (who) email = who.email;
  }
  if (!email) return res.status(401).json({ ok: false, error: 'Not authorized' });

  /* ============ POST actions ============ */
  if (req.method === 'POST') {
    let body = {}; try { body = req.body || {}; } catch {}
    const action = body.action || '';
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });

    if (action === 'sync_zztest') {
      const hs = await hsFetchClient();
      if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status) });
      const r = await upsertHsClient(s, hs.body || {});
      if (!r.ok) return res.status(500).json({ ok: false, error: r.error, detail: r.detail });
      await sbInsert(s, 'events', [{ actor: email, kind: 'client.synced', client_no: TEST_CLIENT, source: 'hawksoft_sync', payload: { policies_synced: r.policies } }]);
      return res.status(200).json({ ok: true, email, synced: { client_no: TEST_CLIENT, policies: r.policies } });
    }

    if (action === 'seed_ids') {
      const force = !!body.force; // force=true => return ALL ids (re-sync existing rows with latest mapping)
      const hs = await hsAllClientIds();
      if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status), detail: hs.body });
      const ids = Array.isArray(hs.body) ? hs.body.map(Number).filter(isFinite) : [];
      if (force) return res.status(200).json({ ok: true, email, total: ids.length, already: 0, count: ids.length, ids, resync: true });
      const have = new Set();
      for (let from = 0; ; from += 1000) {
        const r = await fetch(`${s.base}/rest/v1/clients?select=client_no&order=client_no.asc`, {
          headers: { ...s.hdrs, Range: `${from}-${from + 999}` },
        });
        const page = await r.json().catch(() => []);
        if (!Array.isArray(page) || !page.length) break;
        for (const row of page) have.add(Number(row.client_no));
        if (page.length < 1000) break;
      }
      const todo = ids.filter(n => !have.has(n));
      return res.status(200).json({ ok: true, email, total: ids.length, already: have.size, count: todo.length, ids: todo });
    }

    if (action === 'seed_batch') {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(isFinite).slice(0, 25) : [];
      if (!ids.length) return res.status(400).json({ ok: false, error: 'ids required' });
      const hs = await hsClientBatch(ids);
      if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status), detail: typeof hs.body === 'string' ? hs.body.slice(0, 200) : hs.body });
      const list = Array.isArray(hs.body) ? hs.body : [];
      let ok = 0, pols = 0, failed = [];
      for (const c of list) {
        const r = await upsertHsClient(s, c);
        if (r.ok) { ok++; pols += r.policies; } else failed.push(r.error);
      }
      await sbInsert(s, 'events', [{ actor: email, kind: 'clients.bulk_seeded', source: 'hawksoft_sync', payload: { requested: ids.length, upserted: ok, policies: pols } }]);
      return res.status(200).json({ ok: true, email, upserted: ok, policies: pols, requested: ids.length, failed_count: failed.length });
    }

    if (action === 'start_resync') {
      const existing = await getActiveJob(s);
      if (existing) return res.status(200).json({ ok: true, already: true, job: existing });
      const hs = await hsAllClientIds();
      if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status) });
      const ids = Array.isArray(hs.body) ? hs.body.map(Number).filter(isFinite) : [];
      const ins = await fetch(`${s.base}/rest/v1/sync_jobs`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' },
        body: JSON.stringify([{ kind: 'resync_all', status: 'running', total: ids.length, ids, started_by: email }]) });
      const jrow = (await ins.json().catch(() => []))[0];
      // do one step immediately so progress starts
      const step = await stepResyncJob(s, jrow, 20000);
      return res.status(200).json({ ok: true, started: true, total: ids.length, ...step });
    }

    if (action === 'step_resync') {
      const job = await getActiveJob(s);
      if (!job) return res.status(200).json({ ok: true, done: true, no_job: true });
      const step = await stepResyncJob(s, job, 45000);
      return res.status(200).json({ ok: true, ...step });
    }

    if (action === 'set_commission') {
      const { agent_email, percentage } = body;
      if (!agent_email || percentage == null) return res.status(400).json({ ok: false, error: 'agent_email + percentage required' });
      await fetch(`${s.base}/rest/v1/agent_commission`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ agent_email, percentage: Number(percentage), updated_by: email, updated_at: new Date().toISOString() }]),
      });
      return res.status(200).json({ ok: true, email, agent_email, percentage: Number(percentage) });
    }

    if (action === 'move_client') {
      /* Payment filed against the wrong client. The money is correct — only the record
         is wrong — so nothing is refunded and the Clover transaction is untouched.
         Within 15 minutes the agent who charged it can fix their own slip immediately
         (Tony is told, not asked). After that it becomes a request for Tony, and the
         payment leaves the audit queue so nobody works on it meanwhile. */
      const paymentId = String((req.body || {}).payment_id || '');
      const toClient = parseInt((req.body || {}).to_client, 10);
      const reason = String((req.body || {}).reason || '').slice(0, 200);
      if (!paymentId || !toClient) return res.status(400).json({ ok: false, error: 'payment_id and to_client required' });

      const cur = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=*`);
      const row = (cur.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'Payment not found' });
      if (row.client_id === toClient) return res.status(400).json({ ok: false, error: 'That is already the client on this payment.' });

      const me2 = String(email).toLowerCase();
      const isAdmin = ADMIN_ALLOWLIST.includes(me2);
      const iCharged = agentEmailOf(row.agent) === me2;
      const iOwn = (row.commission_to || agentEmailOf(row.agent)) === me2;
      if (!isAdmin && !iCharged && !iOwn) {
        return res.status(403).json({ ok: false, error: 'You can only correct a payment you took.' });
      }

      const chk = await sbGet(s, `clients?client_no=eq.${toClient}&select=client_no,first_name,last_name,business_name`);
      const dest = (chk.rows || [])[0];
      if (!dest) return res.status(400).json({ ok: false, error: 'No client #' + toClient + ' in our records. Check the number.' });

      const ageMin = (Date.now() - new Date(row.ts)) / 60000;
      const selfServe = isAdmin || (iCharged && ageMin <= 15 && row.audit_status !== 'complete');

      if (!selfServe) {
        await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ correction_status: 'pending', correction_to_client: toClient,
            correction_requested_by: me2, correction_requested_at: new Date().toISOString(), correction_note: reason }) });
        await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ ts: new Date().toISOString(), actor: me2, kind: 'client.correction_requested',
            client_no: row.client_id, source: 'portal',
            payload: { payment_id: paymentId, amount: row.amount, from: row.client_id, to: toClient, reason } }) });
        return res.status(200).json({ ok: true, pending: true,
          message: 'Sent to Tony to approve. It will stay out of your list until he decides.' });
      }

      const applied = await applyClientMove(s, row, toClient, me2, reason, false);
      return res.status(200).json({ ok: true, pending: false, ...applied });
    }

    /* ---------- A payment that pays down an earlier one ----------
       The charge sheet's "Pay this balance" handles this going forward. Nothing handled
       it AFTERWARDS, so a payment taken as a fresh charge stayed a separate sale: it sat
       in the audit queue asking for proof it will never have, and the original kept
       showing money outstanding that had in fact arrived. It needed a hand-written SQL
       UPDATE twice in two days — 25420's $34 and 24615's $87 — which is the definition
       of something that should be an agent action.

       NOT an "edit the charge" screen, deliberately. The amount on a row is a real
       Clover transaction; a box that lets someone change 130.50 to 164.50 would put our
       ledger at odds with the card processor. Same principle move_client states: the
       money is correct, only the record is wrong.

       This MOVES MONEY. Linking raises the parent's collected total, which raises the
       released share of its commission — 25420 went from $1.41 to $1.78 earned. So the
       guards are the ownership test move_client uses, plus refusals for every state
       where a link would destroy or invent something. */
    if (action === 'link_balance' || action === 'unlink_balance') {
      const paymentId = String((req.body || {}).payment_id || '');
      const parentId  = String((req.body || {}).parent_id || '');
      if (!paymentId) return res.status(400).json({ ok: false, error: 'payment_id required' });

      const cur = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=*`);
      const row = (cur.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'Payment not found' });

      const me2 = String(email).toLowerCase();
      const isAdmin = ADMIN_ALLOWLIST.includes(me2);
      const iCharged = agentEmailOf(row.agent) === me2;
      const iOwn = (row.commission_to || agentEmailOf(row.agent)) === me2;
      if (!isAdmin && !iCharged && !iOwn) {
        return res.status(403).json({ ok: false, error: 'You can only correct a payment you took.' });
      }
      /* A completed audit carries its own carrier cost and its own fee. Turning it into
         a balance payment would strand both — and the Trust tab reads fee_amount with no
         audit_status filter, so that fee would keep counting as Speedy profit on a row
         nobody can reach any more. Admin only, and only via a deliberate decision. */
      if (row.audit_status === 'complete') {
        return res.status(403).json({ ok: false, error: 'That payment is already audited. Ask Tony — its carrier cost and fee would have to be undone first.' });
      }
      if (row.correction_status === 'pending') {
        return res.status(403).json({ ok: false, error: 'That payment is waiting on Tony for a different correction.' });
      }
      /* Declined, voided and refunded rows never moved money. Tested inline: the
         NON_PAYMENT list lives inside portal_home's own block and is not in scope here. */
      if (/declin|fail|void|refund/i.test(String(row.kind || ''))
          || ['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'].includes(row.audit_status)) {
        return res.status(400).json({ ok: false, error: 'That row is not a collected payment.' });
      }

      const stamp = new Date().toISOString();
      const amt = Number(row.amount || 0);

      if (action === 'unlink_balance') {
        if (!row.balance_of) return res.status(400).json({ ok: false, error: 'That payment is not linked to anything.' });
        const oldParent = row.balance_of;
        await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ balance_of: null }) });
        /* The link note is already permanent in HawkSoft, so leaving it unanswered would
           make the client file lie. Same reason note_wrong_policy writes to both tabs. */
        let noteOk = false;
        try {
          const r = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${row.client_id}/log?version=4.0`, {
            method: 'POST',
            body: JSON.stringify({ refId: randomUUID(), ts: stamp, channel: 32,
              note: `CORRECTION — the $${amt.toFixed(2)} payment on this record is NO LONGER recorded as paying down an `
                + `earlier payment. It stands on its own again and will be audited separately. `
                + `No refund and no re-charge; the card transaction is unchanged. Corrected by ${me2}.` }) });
          noteOk = (r.status === 200 || r.status === 202);
        } catch { noteOk = false; }
        await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ ts: stamp, actor: me2, kind: 'payment.balance_unlinked',
            client_no: row.client_id, source: 'portal',
            payload: { payment_id: paymentId, was_balance_of: oldParent, amount: amt, hawksoft_note: noteOk } }) });
        return res.status(200).json({ ok: true, unlinked: true, hawksoft_note: noteOk,
          message: 'Unlinked. That payment stands on its own again and will need its own audit.' });
      }

      /* ---- LINK ---- */
      if (row.balance_of) return res.status(400).json({ ok: false, error: 'That payment is already linked to an earlier one.' });
      if (!parentId) return res.status(400).json({ ok: false, error: 'parent_id required' });
      if (parentId === paymentId) return res.status(400).json({ ok: false, error: 'A payment cannot pay down itself.' });
      /* Carrier work already recorded on this row. Clearing it silently would throw away
         a carrier payment somebody entered; refusing leaves the row exactly as it is. */
      if (row.service_cost != null || row.fee_amount != null) {
        return res.status(400).json({ ok: false, error: 'That payment already has a carrier cost recorded, so it is being audited as its own sale. Ask Tony.' });
      }

      const par = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(parentId)}&select=*`);
      const parent = (par.rows || [])[0];
      if (!parent) return res.status(404).json({ ok: false, error: 'That earlier payment could not be found.' });
      if (Number(parent.client_id) !== Number(row.client_id)) {
        return res.status(400).json({ ok: false, error: 'Both payments have to be on the same client.' });
      }
      if (parent.balance_of) {
        return res.status(400).json({ ok: false, error: 'That earlier payment is itself a balance payment. Link to the original charge instead.' });
      }
      if (parent.total_owed == null) {
        return res.status(400).json({ ok: false, error: 'That earlier payment has no total recorded, so it is not showing a balance owed. It has to be audited with the total first.' });
      }

      /* What is genuinely still outstanding, computed the way collectedFor/owedFor do
         (platform.js:95-105) rather than trusting the browser's arithmetic. */
      const sib = await sbGet(s, `bridge_ledger?balance_of=eq.${encodeURIComponent(parentId)}&select=amount`);
      const already = (sib.rows || []).reduce((a, r) => a + Number(r.amount || 0), 0);
      const pAmt = Number(parent.amount || 0);
      const pOwed = Number(parent.total_owed);
      const owed = pOwed > pAmt ? pOwed : pAmt;
      const collected = +(pAmt + already).toFixed(2);
      const outstanding = +(owed - collected).toFixed(2);
      if (outstanding <= 0.005) {
        return res.status(400).json({ ok: false, error: 'That earlier payment is already fully collected — there is no balance left to pay down.' });
      }
      /* MORE than is outstanding is not a balance payment. Refusing withholds only the
         LINK: the row stays exactly as it is, a separate sale, which is a safe place to
         land. Inventing an over-collection is not. */
      if (amt > outstanding + 0.005) {
        return res.status(400).json({ ok: false,
          error: `This payment is $${amt.toFixed(2)} but only $${outstanding.toFixed(2)} is still owed on that one. Ask Tony — part of this money belongs somewhere else.` });
      }

      await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ balance_of: parentId }) });

      const nowCollected = +(collected + amt).toFixed(2);
      const stillOwed = +(owed - nowCollected).toFixed(2);

      /* A log note so an auditor can follow the money — the same reason the retro-linker
         writes one. It explains why a second payment on this client shows no audit of
         its own, which is otherwise unexplainable from the HawkSoft side. Fail-soft:
         a note that does not post must never undo the link. */
      let noteOk = false;
      try {
        const r = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${row.client_id}/log?version=4.0`, {
          method: 'POST',
          body: JSON.stringify({ refId: randomUUID(), ts: stamp, channel: 32,
            note: `The $${amt.toFixed(2)} payment on this record pays down the $${pAmt.toFixed(2)} payment of `
              + `${String(parent.ts || '').slice(0, 10)}, which carries the audit for this sale. `
              + `Total owed $${owed.toFixed(2)} · collected $${nowCollected.toFixed(2)} · `
              + `${stillOwed > 0.005 ? 'still owed $' + stillOwed.toFixed(2) : 'now paid in full'}. `
              + `No separate carrier cost or fee applies to this payment. Linked by ${me2}.` }) });
        noteOk = (r.status === 200 || r.status === 202);
      } catch { noteOk = false; }

      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: stamp, actor: me2, kind: 'payment.balance_linked',
          client_no: row.client_id, source: 'portal',
          payload: { payment_id: paymentId, parent_id: parentId, amount: amt,
                     total_owed: owed, collected_before: collected, collected_after: nowCollected,
                     still_owed: stillOwed, owner: parent.commission_to || agentEmailOf(parent.agent),
                     hawksoft_note: noteOk } }) });

      return res.status(200).json({ ok: true, linked: true, parent_id: parentId,
        total_owed: owed, collected: nowCollected, still_owed: stillOwed, hawksoft_note: noteOk });
    }

    /* ---------- Item 70 step 4: STAFF & PERMISSIONS, the write side ----------
       Tony grants capabilities per agent from here. Gated on `manage_agents`, which is
       resolved by may() rather than by comparing an email - the whole reason step 2
       exists, so refunds and month approval ask the same question in one place.

       EVERY CHANGE NEEDS A REASON. Saif, Sep 10: everything that happens has to be
       explainable, so Tony or whoever holds the permission can understand why. A reason
       cannot be reconstructed later, so it is required at the time and written to
       `events` alongside a before/after of exactly what moved. */
    if (action === 'save_agent' || action === 'add_agent') {
      const me2 = String(email).toLowerCase();
      if (!(await may(me2, 'manage_agents'))) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to manage staff.' });
      }
      const b2 = req.body || {};
      const target = String(b2.email || '').toLowerCase().trim();
      const reason = String(b2.reason || '').trim().slice(0, 200);
      if (!target) return res.status(400).json({ ok: false, error: 'email required' });
      if (!reason) return res.status(400).json({ ok: false, error: 'A reason is required — it is what makes the change explainable later.' });
      /* The table may only ever hold @speedyins.com, enforced here as well as on the
         read: a row it cannot grant anything to should not be creatable either. */
      if (!/@speedyins\.com$/.test(target)) {
        return res.status(400).json({ ok: false, error: 'Only @speedyins.com addresses can be added.' });
      }

      const cur = await sbGet(s, `agents?email=eq.${encodeURIComponent(target)}&select=*`);
      const before = (cur.rows || [])[0] || null;
      if (action === 'add_agent' && before) return res.status(400).json({ ok: false, error: 'That person is already on the list.' });
      if (action === 'save_agent' && !before) return res.status(404).json({ ok: false, error: 'That person is not on the list.' });

      /* Only ever the closed set, and only capabilities the code understands. A role or
         grant this build does not know about is rejected rather than stored, so the
         table can never carry a permission with no meaning. */
      const role = b2.role === undefined ? (before ? before.role : 'agent') : String(b2.role);
      if (!ROLE_CAPS[role]) return res.status(400).json({ ok: false, error: 'Unknown role.' });
      const grants = b2.grants === undefined ? (before ? (before.grants || []) : [])
        : (Array.isArray(b2.grants) ? b2.grants.map(String) : null);
      if (!Array.isArray(grants)) return res.status(400).json({ ok: false, error: 'grants must be a list.' });
      const badGrant = grants.find(g => !ALL_CAPS.has(g));
      if (badGrant) return res.status(400).json({ ok: false, error: `Unknown permission: ${badGrant}` });
      const active = b2.active === undefined ? (before ? before.active : true) : (b2.active === true);

      /* ---- GUARDRAILS. Each one exists because its absence is a way to lock the
         agency out of its own system. ---- */
      /* You cannot change your OWN role or deactivate yourself. Aug 30's rule in a new
         place: a gate must never be able to lock the owner out of the tool used to fix
         it, and the fastest way to do that is a mis-click on your own row. */
      if (target === me2 && before && (role !== before.role || active !== before.active)) {
        return res.status(403).json({ ok: false, error: 'You cannot change your own role or deactivate yourself. Ask another owner.' });
      }
      /* The last owner may never be removed, demoted or deactivated. */
      if (before && before.role === 'owner' && (role !== 'owner' || !active)) {
        const owners = await sbGet(s, 'agents?role=eq.owner&active=is.true&select=email');
        if ((owners.rows || []).length <= 1) {
          return res.status(403).json({ ok: false, error: 'That is the last active owner. Make someone else an owner first.' });
        }
      }

      /* The branch has to be one of the five HawkSoft offices or the pre-selection at
         sign-in matches nothing and the agent silently gets the picker with no default.
         The page sends a value from the same list, so anything else is a bad client. */
      const branchIn = b2.branch !== undefined ? (String(b2.branch).trim() || null) : undefined;
      if (branchIn && !OFFICE_NAMES.includes(branchIn)) {
        return res.status(400).json({ ok: false, error: `Unknown branch: ${branchIn}` });
      }

      const patch = {
        full_name: b2.full_name !== undefined ? String(b2.full_name).slice(0, 80) : (before ? before.full_name : target),
        branch: branchIn !== undefined ? branchIn : (before ? before.branch : null),
        producer_code: b2.producer_code !== undefined ? (String(b2.producer_code).toUpperCase().slice(0, 8) || null) : (before ? before.producer_code : null),
        /* Editable from the page, at Saif's request: the note is where the reason a
           record looks odd gets written down, and it was read-only before. */
        notes: b2.notes !== undefined ? (String(b2.notes).slice(0, 400) || null) : (before ? before.notes : null),
        role, grants, active,
        updated_by: me2, updated_at: new Date().toISOString(),
      };

      if (action === 'add_agent') {
        const ins = await sbInsert(s, 'agents', [{ email: target, ...patch }]);
        if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not add them (' + ins.status + ').' });
      } else {
        const up = await fetch(`${s.base}/rest/v1/agents?email=eq.${encodeURIComponent(target)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
        if (!up.ok) return res.status(500).json({ ok: false, error: 'Could not save (' + up.status + ').' });
      }

      /* WHAT ACTUALLY MOVED, field by field, so the activity view can answer "why does
         Yasmin have refund?" without anyone reconstructing it from memory. */
      const changed = {};
      for (const k of ['full_name', 'branch', 'producer_code', 'notes', 'role', 'active']) {
        const was = before ? before[k] : null;
        if (String(was) !== String(patch[k])) changed[k] = { from: was, to: patch[k] };
      }
      const wasGrants = before ? (before.grants || []) : [];
      if (wasGrants.slice().sort().join(',') !== grants.slice().sort().join(',')) {
        changed.grants = { from: wasGrants, to: grants,
          added: grants.filter(g => !wasGrants.includes(g)),
          removed: wasGrants.filter(g => !grants.includes(g)) };
      }
      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: new Date().toISOString(), actor: me2,
          kind: action === 'add_agent' ? 'agent.added' : 'agent.updated',
          client_no: null, source: 'console',
          payload: { agent: target, reason, changed } }) });

      /* The cache is 60s. After a permission change that is far too long to wait, and
         it is exactly when someone is watching to see if it worked. */
      _roster = null; _rosterUntil = 0;
      return res.status(200).json({ ok: true, email: target, changed, reason });
    }

    /* ================= REFUNDS · STAGES 1-3 =================
       A refund is a NEW ROW pointing at the payment it reverses, never a change to that
       payment. Three reasons, none of them taste:
         · "nothing is ever reversed" is the standing rule;
         · the refund needs its OWN date, or "commission reduces in the month of the
           REFUND" cannot be built;
         · mutating an audited row is exactly what the partial-save negative-fee bug
           taught us not to do.
       Same shape as balance_of, which already points a later row at an earlier one.

       IT LIVES HERE, NOT IN hawksoft.js, on purpose. Refunds must be gated by
       may(email,'refund') — the permission Tony grants on the Staff page — and may() is
       here. hawksoft.js authorises with a raw admin key, which is why Saif hit "why do I
       need the key when I am already signed in". A money action an owner performs from a
       signed-in session must not require a secret in a shell. platform.js already reads
       the Clover env key's siblings and writes HawkSoft log notes (the correction flow
       does both), so nothing had to move.

       ⚠️ HOW THE COMMISSION REDUCTION ACTUALLY HAPPENS, because it is not obvious.
       portal_home pays commission as `fee * pct * collectedRatio`, counted in the period
       containing `audit_completed_at || ts`. So the refund row carries a NEGATIVE
       fee_amount, audit_status 'complete', and audit_completed_at set to the refund's own
       timestamp — and the existing engine then puts a negative commission line in the
       month of the refund, leaving the original month untouched. No new commission code,
       and Tony's "a closed month never moves" holds by construction.
       This is also why `collectedFor` is deliberately NOT changed to net refunds: that
       would reduce the ORIGINAL month's commission as well, counting the reversal twice.

       TWO THINGS ARE REFUSED HERE RATHER THAN GUESSED:
       1. A PARTIAL amount. Clover's docs contradict each other on whether /v1/refunds
          accepts one, and both stage-0 probe POSTs died on a non-existent charge before
          the field was ever validated. Attempting a partial that Clover silently treats
          as FULL hands the client more than intended, and we would learn it from a
          statement. Stage 4, after tomorrow's test.
       2. A payment on an obligation that is NOT yet fully collected. The commission
          arithmetic above is exact only when the parent's collected ratio is unchanged by
          the refund; on a part-paid obligation, closing it moves `owedFor`'s fallback and
          would silently INCREASE the original month. Five rows in 427 carry a total_owed
          at all, and all five are hand corrections, so this costs almost nothing today
          and avoids a wrong number. */
    if (action === 'refund_payment') {
      const me2 = String(email).toLowerCase();
      if (!(await may(me2, 'refund'))) {
        return res.status(403).json({ ok: false, error: 'not_permitted',
          message: 'You cannot issue a refund. Tony can, and he can also give you the permission on the Staff page.' });
      }
      const out = await issueRefund(s, me2, req.body || {});
      return res.status(out.status).json(out.body);
    }

    /* ================= REFUND REQUESTS — the agent's half =================
       Saif, Sep 10: "agent self-serve inside a window, then it becomes a request for
       Tony — move_client's shape." The window needs a number from Tony and is not
       built; this is the request. An agent fills in the SAME sheet — why, carrier,
       tell the client, reason — and nothing moves. Tony approves from the Console and
       the refund is issued through issueRefund() with the agent's answers, exactly as
       if he had opened the sheet himself. */
    if (action === 'request_refund') {
      const me2 = String(email).toLowerCase();
      const b3 = req.body || {};
      /* Everything is validated by the real refund code in dry-run mode, so a request
         that would be refused at approval time is refused NOW, to the agent, with the
         same message Tony would have seen. */
      const dry = await issueRefund(s, me2, b3, { dryRun: true });
      if (dry.status !== 200) return res.status(dry.status).json(dry.body);
      const d = dry.body;
      const paymentId = String(b3.payment_id || '').trim();
      /* One open request per payment — enforced by a partial unique index too. */
      const open = await sbGet(s, `refund_requests?payment_id=eq.${encodeURIComponent(paymentId)}&status=eq.pending&select=id,requested_by,requested_at`);
      if ((open.rows || []).length) {
        const o = open.rows[0];
        return res.status(409).json({ ok: false, error: 'already_requested',
          message: `A refund of this payment is already waiting for Tony — asked by ${AGENT_NAME[o.requested_by] || o.requested_by} on ${String(o.requested_at).slice(0, 10)}.` });
      }
      const reqId = randomUUID();
      const stamp = new Date().toISOString();
      const row = { id: reqId, payment_id: paymentId, client_id: d.client_id, requested_by: me2,
        requested_at: stamp, amount: d.amount, reason: String(b3.reason), carrier: String(b3.carrier),
        notify: d.notify, note: String(b3.note || '').trim().slice(0, 400), status: 'pending', is_test: d.is_test };
      const ins = await sbInsert(s, 'refund_requests', [row]);
      if (!ins.ok) return res.status(500).json({ ok: false, error: 'Could not save the request (' + ins.status + ').' });
      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: stamp, actor: me2, kind: 'refund.requested', client_no: d.client_id,
          source: 'portal', payload: { request_id: reqId, payment_id: paymentId, amount: d.amount,
            method: d.method, reason: row.reason, carrier: row.carrier, notify: d.notify, note: row.note } }) });
      return res.status(200).json({ ok: true, request_id: reqId, amount: d.amount,
        message: `Sent to Tony. Nothing has been refunded yet — you will be told when he decides.` });
    }

    /* Tony's half. Approve issues the refund NOW, through the same path, as Tony, with
       the agent's answers. Decline needs a reason — the agent asked, and "no" with
       nothing behind it is the silence Saif does not want. */
    if (action === 'decide_refund') {
      const me2 = String(email).toLowerCase();
      if (!(await may(me2, 'refund'))) {
        return res.status(403).json({ ok: false, error: 'You do not have permission to decide refunds.' });
      }
      const b3 = req.body || {};
      const reqId = String(b3.request_id || '').trim();
      const approve = b3.approve === true;
      const decisionNote = String(b3.note || '').trim().slice(0, 300);
      if (!reqId) return res.status(400).json({ ok: false, error: 'request_id required' });
      if (!approve && !decisionNote) return res.status(400).json({ ok: false, error: 'Say why it is declined — the agent will read it.' });
      const rr = await sbGet(s, `refund_requests?id=eq.${encodeURIComponent(reqId)}&select=*`);
      const rq = (rr.rows || [])[0];
      if (!rq) return res.status(404).json({ ok: false, error: 'No such request.' });
      if (rq.status !== 'pending') return res.status(409).json({ ok: false, error: `That request was already ${rq.status}.` });
      const stamp = new Date().toISOString();
      let refundOut = null;
      if (approve) {
        /* The agent's answers, verbatim, plus who asked — so the ledger row, the
           HawkSoft note and the event all say this was Sammy's request that Tony
           approved, not something Tony did on his own. */
        refundOut = await issueRefund(s, me2, {
          payment_id: rq.payment_id, reason: rq.reason, carrier: rq.carrier, notify: rq.notify,
          note: rq.note + ` (requested by ${rq.requested_by}, approved by ${me2}` + (decisionNote ? ': ' + decisionNote : '') + ')',
          amount: Number(rq.amount) });
        if (refundOut.status !== 200) {
          /* The request STAYS PENDING: the refund did not happen, so the queue must
             still show it. The error goes back to Tony as-is. */
          return res.status(refundOut.status).json({ ...refundOut.body, request_still_pending: true });
        }
      }
      await fetch(`${s.base}/rest/v1/refund_requests?id=eq.${encodeURIComponent(reqId)}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ status: approve ? 'approved' : 'declined', decided_by: me2, decided_at: stamp,
          decision_note: decisionNote || null, refund_id: approve ? refundOut.body.refund_id : null }) });
      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: stamp, actor: me2, kind: 'refund.decided', client_no: rq.client_id,
          source: 'console', payload: { request_id: reqId, payment_id: rq.payment_id, requested_by: rq.requested_by,
            amount: Number(rq.amount), approved: approve, note: decisionNote || null,
            refund_id: approve ? refundOut.body.refund_id : null } }) });
      return res.status(200).json({ ok: true, approved: approve, request_id: reqId,
        ...(approve ? refundOut.body : {}) });
    }

    /* ================= STAGE 5 — settle the carrier's share =================
       A refund with carrier 'pending' sits in Trust's carrier_to_recover with nothing
       chasing it. This is the transition out: 'yes' (the carrier paid us back — the
       cost reverses) or 'no' (it is a loss). Money decision, so: permission, reason,
       event. The Trust arithmetic for both answers already exists and is tested; only
       the transition is new. */
    /* ---------- AUDIT REVIEW (Sep 12) ----------
       The agent submits (carrier.js: audit_status -> ready_for_audit). Someone holding
       audit_approve approves or sends back. Approval is what earns the commission and
       the approval date is what dates it (Tony's rule, Sep 1). Nobody approves their
       own: the row's owner (commission_to) and the submitter are both refused. */
    if (action === 'approve_audit' || action === 'approve_audits' || action === 'reject_audit') {
      const me2 = String(email).toLowerCase();
      if (!(await may(me2, 'audit_approve'))) return res.status(403).json({ ok: false, error: 'You do not have permission to approve audits.' });
      const b3 = req.body || {};
      const ids = action === 'approve_audits'
        ? [...new Set((Array.isArray(b3.payment_ids) ? b3.payment_ids : []).map(x => String(x || '').trim()).filter(Boolean))]
        : [String(b3.payment_id || '').trim()].filter(Boolean);
      if (!ids.length) return res.status(400).json({ ok: false, error: 'payment_id required' });
      if (ids.length > 50) return res.status(400).json({ ok: false, error: 'At most 50 at a time.' });
      const approving = action !== 'reject_audit';
      let code = null, why = null;
      if (!approving) {
        code = String(b3.code || '').trim();
        why = String(b3.reason || '').trim().slice(0, 500);
        if (!AUDIT_SENDBACK_CODES[code]) return res.status(400).json({ ok: false, error: 'Pick a reason.' });
        if (!why) return res.status(400).json({ ok: false, error: 'Say what the agent needs to fix — they read this.' });
      }
      const rr = await sbGet(s, `bridge_ledger?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,client_id,amount,agent,commission_to,audit_status,audit_submitted_by,audit_submitted_at,audit_sendback,service_cost,fee_amount,carrier_name`);
      const byId = {}; for (const r of (rr.rows || [])) byId[r.id] = r;
      const stamp = new Date().toISOString();
      const results = [];
      for (const id of ids) {
        const row = byId[id];
        if (!row) { results.push({ id, ok: false, error: 'No such payment.' }); continue; }
        if (row.audit_status !== 'ready_for_audit') { results.push({ id, ok: false, error: `Not waiting for approval (it is "${row.audit_status || 'client_paid'}").` }); continue; }
        const owner = String(row.commission_to || agentEmailOf(row.agent) || '').toLowerCase();
        const submitter = String(row.audit_submitted_by || '').toLowerCase();
        if (owner === me2 || submitter === me2) { results.push({ id, ok: false, error: 'You cannot approve your own audit.' }); continue; }
        if (approving) {
          if (row.service_cost == null) { results.push({ id, ok: false, error: 'No carrier cost on this row — send it back instead.' }); continue; }
          const p1 = await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(id)}&audit_status=eq.ready_for_audit`, {
            method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=representation' },
            body: JSON.stringify({ audit_status: 'complete', audit_completed_by: me2, audit_completed_at: stamp }) });
          const got = await p1.json().catch(() => []);
          if (!Array.isArray(got) || !got.length) { results.push({ id, ok: false, error: 'It changed under you — reload.' }); continue; }
          await fetch(`${s.base}/rest/v1/audit_reviews`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify([{ payment_id: id, action: 'approved', actor: me2, bulk: action === 'approve_audits', at: stamp }]) });
          await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify({ ts: stamp, actor: me2, kind: 'audit.approved', client_no: row.client_id, source: 'console',
              payload: { payment_id: id, owner, submitted_by: submitter || null, amount: Number(row.amount || 0),
                carrier: row.carrier_name || null, carrier_amount: row.service_cost != null ? Number(row.service_cost) : null,
                fee: row.fee_amount != null ? Number(row.fee_amount) : null, bulk: action === 'approve_audits',
                after_sendback: !!row.audit_sendback } }) });
          results.push({ id, ok: true, status: 'complete' });
        } else {
          const sendback = { by: me2, at: stamp, code, reason: why };
          const p1 = await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(id)}&audit_status=eq.ready_for_audit`, {
            method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=representation' },
            body: JSON.stringify({ audit_status: 'carrier_pending', audit_sendback: sendback }) });
          const got = await p1.json().catch(() => []);
          if (!Array.isArray(got) || !got.length) { results.push({ id, ok: false, error: 'It changed under you — reload.' }); continue; }
          await fetch(`${s.base}/rest/v1/audit_reviews`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify([{ payment_id: id, action: 'sent_back', actor: me2, reason_code: code, reason: why, at: stamp }]) });
          /* The agent hears it through portal_news; owner and submitter both, when they differ. */
          await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify({ ts: stamp, actor: me2, kind: 'audit.sent_back', client_no: row.client_id, source: 'console',
              payload: { payment_id: id, owner, submitted_by: submitter || null, amount: Number(row.amount || 0),
                code, code_label: AUDIT_SENDBACK_CODES[code], reason: why } }) });
          results.push({ id, ok: true, status: 'carrier_pending', sendback });
        }
      }
      const okN = results.filter(r => r.ok).length;
      if (action === 'approve_audits') return res.status(200).json({ ok: okN > 0, approved: okN, failed: results.length - okN, results });
      const one = results[0];
      return res.status(one.ok ? 200 : 409).json(one.ok ? { ok: true, ...one } : { ok: false, error: one.error });
    }

    if (action === 'settle_carrier') {
      const me2 = String(email).toLowerCase();
      if (!(await may(me2, 'refund'))) return res.status(403).json({ ok: false, error: 'You do not have permission to settle refunds.' });
      const b3 = req.body || {};
      const refundId = String(b3.refund_id || '').trim();
      const answer = String(b3.carrier || '').trim();
      const why = String(b3.note || '').trim().slice(0, 300);
      if (!refundId) return res.status(400).json({ ok: false, error: 'refund_id required' });
      if (answer !== 'yes' && answer !== 'no') return res.status(400).json({ ok: false, error: "carrier must be 'yes' (they paid us back) or 'no' (it is a loss)." });
      if (!why) return res.status(400).json({ ok: false, error: 'Say how you know — a remittance, a call, a statement.' });
      const rr = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(refundId)}&select=id,kind,client_id,amount,refund_of,refund_carrier`);
      const rf = (rr.rows || [])[0];
      if (!rf || rf.kind !== 'charge_refund') return res.status(404).json({ ok: false, error: 'No such refund.' });
      if (rf.refund_carrier !== 'pending') return res.status(409).json({ ok: false, error: `That one is already settled as "${rf.refund_carrier}".` });
      const stamp = new Date().toISOString();
      await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(refundId)}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ refund_carrier: answer }) });
      await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: stamp, actor: me2, kind: 'refund.carrier_settled', client_no: rf.client_id,
          source: 'console', payload: { refund_id: refundId, payment_id: rf.refund_of,
            amount: Math.abs(Number(rf.amount || 0)), was: 'pending', now: answer, note: why } }) });
      return res.status(200).json({ ok: true, refund_id: refundId, carrier: answer });
    }

    if (action === 'decide_correction') {
      if (!ADMIN_ALLOWLIST.includes(String(email).toLowerCase())) {
        return res.status(403).json({ ok: false, error: 'Owner only' });
      }
      const paymentId = String((req.body || {}).payment_id || '');
      const approve = (req.body || {}).approve === true;
      const cur = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=*`);
      const row = (cur.rows || [])[0];
      if (!row || row.correction_status !== 'pending') return res.status(404).json({ ok: false, error: 'No pending correction on that payment.' });

      if (!approve) {
        await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ correction_status: 'rejected', correction_decided_by: email, correction_decided_at: new Date().toISOString() }) });
        await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ ts: new Date().toISOString(), actor: email, kind: 'client.correction_rejected',
            client_no: row.client_id, source: 'console',
            payload: { payment_id: paymentId, requested_by: row.correction_requested_by, to: row.correction_to_client } }) });
        return res.status(200).json({ ok: true, approved: false });
      }
      const applied = await applyClientMove(s, row, row.correction_to_client, email, row.correction_note || '', true);
      return res.status(200).json({ ok: true, approved: true, ...applied });
    }

    if (action === 'set_share') {
      /* One decision, then locked. Skipping counts as 0% — otherwise a forgotten prompt
         would leave commission unresolved forever. Only the owner decides; Tony can
         override a locked split from the Audit tab. */
      const paymentId = String((req.body || {}).payment_id || '');
      const pctRaw = Number((req.body || {}).pct);
      const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 0;
      if (!paymentId) return res.status(400).json({ ok: false, error: 'payment_id required' });

      const cur = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=id,agent,commission_to,share_locked_at,fee_amount,client_id`);
      const row = (cur.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'Payment not found' });

      const me2 = String(email).toLowerCase();
      const isAdmin = ADMIN_ALLOWLIST.includes(me2);
      if (!isAdmin) {
        if (row.commission_to !== me2) return res.status(403).json({ ok: false, error: 'Only the agent who earns this can share it.' });
        if (row.share_locked_at) return res.status(403).json({ ok: false, error: 'This split is already set. Ask Tony if it needs changing.' });
      }

      const helper = agentEmailOf(row.agent);
      const patch = { helper_share_pct: pct, share_locked_at: new Date().toISOString(), share_set_by: me2,
                      helper_email: pct > 0 ? helper : null };
      const up = await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
      if (up.status >= 300) return res.status(502).json({ ok: false, error: 'Could not save it.' });

      await fetch(`${s.base}/rest/v1/events`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: new Date().toISOString(), actor: me2, kind: 'commission.shared',
          client_no: row.client_id, source: 'portal',
          payload: { payment_id: paymentId, owner: row.commission_to, helper, pct,
                     fee: row.fee_amount, by: me2, admin_override: isAdmin } }),
      });
      return res.status(200).json({ ok: true, pct, helper_name: AGENT_NAME[helper] || helper });
    }

    if (action === 'news_seen') {
      await fetch(`${s.base}/rest/v1/agent_prefs`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ agent_email: String(email).toLowerCase(), news_seen_at: new Date().toISOString() }]),
      });
      return res.status(200).json({ ok: true });
    }

    if (action === 'reassign_commission') {
      /* Giving away is safe; taking is not. An agent may hand a payment to anyone if they
         charged it or currently own it. Setting YOURSELF as owner on a payment you neither
         charged nor own would be taking someone else's commission — admin only. */
      const paymentId = String((req.body || {}).payment_id || '');
      const toEmail = agentEmailOf((req.body || {}).to_email);
      if (!paymentId || !toEmail) return res.status(400).json({ ok: false, error: 'payment_id and to_email required' });
      if (!AGENT_NAME[toEmail]) return res.status(400).json({ ok: false, error: 'Unknown agent' });

      const cur = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=id,agent,commission_to,audit_status,amount,client_id,share_locked_at`);
      const row = (cur.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'Payment not found' });

      const me = String(email).toLowerCase();
      const isAdmin = ADMIN_ALLOWLIST.includes(me);
      const currentOwner = row.commission_to || agentEmailOf(row.agent);
      const iCharged = agentEmailOf(row.agent) === me;
      const iOwn = currentOwner === me;

      if (!isAdmin) {
        if (!iCharged && !iOwn) {
          return res.status(403).json({ ok: false, error: 'You can only reassign a payment you charged or currently own.' });
        }
        if (toEmail === me && !iOwn) {
          return res.status(403).json({ ok: false, error: 'You cannot assign a payment to yourself. Ask the owner or Tony.' });
        }
        if (row.share_locked_at) {
          return res.status(403).json({ ok: false, error: 'This payment is locked — its commission split has been set. Ask Tony to change it.' });
        }
      }

      const up = await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${encodeURIComponent(paymentId)}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ commission_to: toEmail }),
      });
      if (up.status >= 300) return res.status(502).json({ ok: false, error: 'Could not save the change.' });

      await fetch(`${s.base}/rest/v1/events`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({ ts: new Date().toISOString(), actor: me, kind: 'commission.reassigned',
          client_no: row.client_id, source: 'portal',
          payload: { payment_id: paymentId, amount: row.amount, from: currentOwner, to: toEmail, by: me } }),
      });
      return res.status(200).json({ ok: true, commission_to: toEmail, name: AGENT_NAME[toEmail] });
    }

    if (action === 'delta_sync') {
      const out = await runDeltaSync(s, email);
      return res.status(out.ok ? 200 : 502).json({ ...out, email });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  // view declared earlier (before portal block)

  /* ---- TEMP: receipts discovery ---- */
  /* ---- HawkSoft direct: ZZTEST raw ---- */
  if (view === 'client') {
    const hs = await hsFetchClient();
    if (hs.error) return res.status(500).json({ ok: false, error: hs.error });
    return res.status(200).json({ ok: hs.status === 200, status: hs.status, email, client: hs.body });
  }

  const s = sb();
  if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });

  /* ---- Our clients list ---- */
  if (view === 'our_clients') {
    const q = String(req.query.q || '').trim();
    let path, MULTI = false, TOKS = [];
    if (q) {
      // Search: client_no exact, OR name/business/phone/email contains (case-insensitive)
      const { ors, multi, toks } = buildClientSearch(q);
      path = `clients?select=*&or=(${ors.join(',')})&order=client_no.asc&limit=${multi ? 800 : 100}`;
      MULTI = multi; TOKS = toks;
    } else {
      path = 'clients?select=*&order=client_no.asc&limit=100';
    }
    const cl = await sbGet(s, path);
    /* Narrow BEFORE the policy-count query below. That query is an in.() over every
       client_no returned, so filtering after it would build an 800-id IN list to
       answer a search that shows 100. */
    if (MULTI) cl.rows = (cl.rows || []).filter(c => matchesAllTokens(c, TOKS)).slice(0, 100);
    // policy counts only for the returned clients
    const nos = (cl.rows || []).map(c => c.client_no).filter(n => n != null);
    let counts = {};
    if (nos.length) {
      const po = await sbGet(s, `policies?select=client_no,status,expiration_date,record_type&client_no=in.(${nos.join(',')})`);
      const today = new Date().toISOString().slice(0,10);
      for (const p of (po.rows || [])) {
        counts[p.client_no] = counts[p.client_no] || { total: 0, inforce: 0, dmv: 0 };
        if (p.record_type === 'dmv_service') { counts[p.client_no].dmv++; continue; }
        if (p.record_type === 'insurance' || !p.record_type) {
          counts[p.client_no].total++;
          const st = String(p.status || '').toLowerCase();
          const live = p.expiration_date && p.expiration_date >= today && !['cancelled','canceled','expired'].includes(st);
          if (live) counts[p.client_no].inforce++;
        }
      }
    }
    return res.status(200).json({ ok: cl.ok, email, clients: cl.rows || [], policy_counts: counts, query: q, total_shown: (cl.rows || []).length });
  }

  /* ---- Our single client: profile + policies + payments + events ---- */
  if (view === 'our_client') {
    const no = parseInt(String(req.query.no || ''), 10);
    if (!isFinite(no)) return res.status(400).json({ ok: false, error: 'no= required' });
    let live = false;
    // Only hit HawkSoft when explicitly asked (background refresh). Default = fast DB read.
    if (String(req.query.refresh || '') === '1') {
      const fresh = await hsFetchClient(no);
      if (!fresh.error && fresh.status === 200 && fresh.body) {
        const up = await upsertHsClient(s, fresh.body);
        live = !!up.ok;
      }
    }
    const [cl, po, led, ev] = await Promise.all([
      sbGet(s, `clients?client_no=eq.${no}&select=*`),
      sbGet(s, `policies?client_no=eq.${no}&select=*&order=expiration_date.desc`),
      sbGet(s, `bridge_ledger?client_id=eq.${no}&select=*&order=ts.desc&limit=50`),
      sbGet(s, `events?client_no=eq.${no}&select=*&order=ts.desc&limit=50`),
    ]);
    return res.status(200).json({ ok: true, email, live, refreshed_at: new Date().toISOString(), client: (cl.rows || [])[0] || null, policies: po.rows || [], payments: led.rows || [], events: ev.rows || [] });
  }

  /* ---- Resync job status ---- */
  /* ---------- Item 70 step 2: prove the resolution BEFORE it gates anything ----------
     Read-only. Gates nothing, changes nothing. It exists so the additive read and may()
     can be checked against a REAL request while every existing gate is still the old
     code path - which is the rule earned on Aug 30, when this work went straight into
     `verifyGoogle` and locked the owner out of the Console.

     Delete this view once the agents page is live and shows the same thing. */
  /* ---------- Item 70 step 4: STAFF & PERMISSIONS, the read side ----------
     Gated on `manage_agents` rather than on being admin, so the page is governed by the
     same question every other guard asks. Returns the roster plus the capability list,
     so the page renders the tick-boxes from what the SERVER understands - a page with a
     hardcoded list of permissions drifts the moment a capability is added. */
  /* THE REFUNDS TAB. Two queues and a history. Owner-gated by the same permission
     that decides them, so the list and the buttons cannot disagree. */
  if (view === 'refund_requests') {
    if (!(await may(email, 'refund'))) {
      return res.status(403).json({ ok: false, error: 'You do not have permission to see refund requests.' });
    }
    const [pend, done, carr] = await Promise.all([
      sbGet(s, 'refund_requests?status=eq.pending&is_test=is.false&select=*&order=requested_at.asc&limit=100'),
      sbGet(s, 'refund_requests?status=neq.pending&is_test=is.false&select=*&order=decided_at.desc&limit=30'),
      sbGet(s, 'bridge_ledger?kind=eq.charge_refund&refund_carrier=eq.pending&is_test=is.false'
        + '&select=id,ts,client_id,amount,refund_of,refund_reason,refund_note,agent,commission_to&order=ts.asc&limit=200'),
    ]);
    /* Each pending request needs its payment's context — carrier, cost, fee — and each
       pending carrier recovery needs its PARENT's carrier and cost. One read for all. */
    const ids = [...new Set([
      ...(pend.rows || []).map(r => r.payment_id),
      ...(carr.rows || []).map(r => r.refund_of)].filter(Boolean))];
    const pays = ids.length
      ? await sbGet(s, `bridge_ledger?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,ts,client_id,amount,purpose,kind,ref,carrier_name,service_cost,fee_amount,commission_to,agent,audit_status`)
      : { rows: [] };
    const pay = Object.fromEntries((pays.rows || []).map(p => [p.id, p]));
    const cids = [...new Set([...(pend.rows || []), ...(carr.rows || []), ...(done.rows || [])].map(r => r.client_id).filter(Boolean))];
    const cls = cids.length ? await sbGet(s, `clients?client_no=in.(${cids.join(',')})&select=client_no,first_name,last_name,business_name`) : { rows: [] };
    const cname = Object.fromEntries((cls.rows || []).map(c => [c.client_no, c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ')]));
    const nameOf = e => AGENT_NAME[e] || (e ? String(e).split('@')[0] : null);
    const shape = r => { const p = pay[r.payment_id] || {}; return {
      id: r.id, payment_id: r.payment_id, client_no: r.client_id, client_name: cname[r.client_id] || null,
      requested_by: r.requested_by, requested_by_name: nameOf(r.requested_by), requested_at: r.requested_at,
      amount: Number(r.amount), reason: r.reason, carrier: r.carrier, notify: r.notify, note: r.note,
      status: r.status, decided_by: r.decided_by, decided_by_name: nameOf(r.decided_by), decided_at: r.decided_at,
      decision_note: r.decision_note, refund_id: r.refund_id,
      payment: { ts: p.ts, amount: p.amount != null ? Number(p.amount) : null, purpose: p.purpose, kind: p.kind, ref: p.ref,
        carrier_name: p.carrier_name, service_cost: p.service_cost != null ? Number(p.service_cost) : null,
        fee_amount: p.fee_amount != null ? Number(p.fee_amount) : null, audit_status: p.audit_status,
        commission_to: p.commission_to || agentEmailOf(p.agent) || null,
        commission_to_name: nameOf(p.commission_to || agentEmailOf(p.agent)) },
    }; };
    return res.status(200).json({ ok: true,
      pending: (pend.rows || []).map(shape),
      decided: (done.rows || []).map(shape),
      /* Refunds the carrier has not answered on. The figure Trust already carries as
         carrier_to_recover, as a list with names on it. */
      carrier_pending: (carr.rows || []).map(r => { const p = pay[r.refund_of] || {}; return {
        refund_id: r.id, payment_id: r.refund_of, client_no: r.client_id, client_name: cname[r.client_id] || null,
        refunded_at: r.ts, amount: Math.abs(Number(r.amount || 0)), reason: r.refund_reason, note: r.refund_note,
        carrier_name: p.carrier_name || null, carrier_cost: p.service_cost != null ? Number(p.service_cost) : 0,
        refunded_by: nameOf(agentEmailOf(r.agent) || r.agent), commission_to_name: nameOf(r.commission_to) }; }),
      carrier_pending_total: +((carr.rows || []).reduce((a, r) => a + ((pay[r.refund_of] || {}).service_cost != null ? Number(pay[r.refund_of].service_cost) : 0), 0)).toFixed(2),
    });
  }

  if (view === 'agents_list') {
    if (!(await may(email, 'manage_agents'))) {
      return res.status(403).json({ ok: false, error: 'You do not have permission to manage staff.' });
    }
    const r = await sbGet(s, 'agents?select=*&order=active.desc,full_name.asc&limit=200');
    const rows = (r.rows || []).map(a => ({
      email: a.email, full_name: a.full_name, branch: a.branch || null,
      producer_code: a.producer_code || null, active: a.active === true,
      role: ROLE_CAPS[a.role] ? a.role : 'agent',
      grants: Array.isArray(a.grants) ? a.grants.filter(g => ALL_CAPS.has(g)) : [],
      /* Flagged so a row the table can grant nothing to is visible on the page. */
      external: !/@speedyins\.com$/.test(String(a.email || '')),
      notes: a.notes || null,
      created_at: a.created_at || null,
      updated_by: a.updated_by || null, updated_at: a.updated_at || null,
    }));
    return res.status(200).json({ ok: true, email,
      me: String(email).toLowerCase(),
      roles: Object.keys(ROLE_CAPS),
      /* The branch dropdown's options come from HERE, not from a list retyped in the
         page. OFFICE_MAP is the same five offices HawkSoft has, and portal.html's
         sign-in picker uses the same names — the whole point of item 22 is that the
         two stop disagreeing. */
      branches: OFFICE_NAMES,
      /* What each role already includes, so the page can show that a tick-box is
         redundant for an owner rather than letting someone "grant" what they have. */
      role_caps: ROLE_CAPS,
      /* Grantable = everything except what is implied by a role bundle at agent level.
         Saif confirmed approve_month IS grantable, against my recommendation. */
      grantable: [...ALL_CAPS].filter(c => !ROLE_CAPS.agent.includes(c)).sort(),
      owners_active: rows.filter(a => a.role === 'owner' && a.active).length,
      rows });
  }

  if (view === 'perm_check') {
    const roster = await loadRoster();
    const admins = await rosterAdmins();
    const agentsSet = await rosterAgents();
    const codeAdmins = ADMIN_ALLOWLIST.map(e => e.toLowerCase());
    const codeAgents = AGENT_ALLOWLIST.map(e => e.toLowerCase());
    const everyone = [...new Set([...codeAdmins, ...codeAgents, ...roster.keys()])].sort();
    const caps = [...ALL_CAPS].sort();

    const rows = [];
    for (const e of everyone) {
      const a = roster.get(e) || null;
      const granted = {};
      for (const c of caps) granted[c] = await may(e, c);
      rows.push({
        email: e,
        in_code_admin: codeAdmins.includes(e),
        in_code_agent: codeAgents.includes(e),
        in_table: !!a,
        active: a ? a.active : null,
        /* Flagged, not hidden: a row the table may not grant anything to should be
           NOTICED here and removed, not silently tolerated. */
        external: a ? a.external : null,
        role: a ? a.role : null,
        grants: a ? a.grants : null,
        can_sign_in_console: admins.has(e),
        can_sign_in_portal: agentsSet.has(e),
        caps: caps.filter(c => granted[c]),
      });
    }
    /* The two assertions that matter. If either fails, do NOT wire this to a gate. */
    const lostConsole = codeAdmins.filter(e => !admins.has(e));
    const lostPortal = codeAgents.filter(e => !agentsSet.has(e));
    const inactiveWithAccess = rows.filter(r => r.in_table && r.active === false
      && (r.can_sign_in_console || r.can_sign_in_portal) && !r.in_code_admin && !r.in_code_agent)
      .map(r => r.email);

    return res.status(200).json({
      ok: true, email,
      roster_rows: roster.size,
      code_floor: { admins: codeAdmins, agents: codeAgents.length },
      capabilities_understood: caps,
      /* MUST all be empty. Anything here means the read is subtractive somewhere. */
      REGRESSIONS: { lost_console: lostConsole, lost_portal: lostPortal,
                     inactive_granted_access: inactiveWithAccess,
                     /* Any of these means somebody put a non-Speedy address in the
                        roster. It is granted nothing, but it should not be there. */
                     external_rows: rows.filter(r => r.external).map(r => r.email) },
      would_gain_console: [...admins].filter(e => !codeAdmins.includes(e)).sort(),
      would_gain_portal: [...agentsSet].filter(e => !codeAgents.includes(e) && !codeAdmins.includes(e)).sort(),
      rows,
    });
  }

  if (view === 'job_status') {
    const job = await getActiveJob(s);
    const last = await sbGet(s, "sync_jobs?order=created_at.desc&limit=1");
    return res.status(200).json({ ok: true, email, job: job || (last.rows || [])[0] || null });
  }

  /* ---- Sync status ---- */
  if (view === 'audit_list') {
    const q = String(req.query.q || '').trim().toLowerCase();
    const AUDIT_CUTOFF = '2026-07-29'; // proof-of-payment process started ~here; older charges are pre-audit
    /* PERFORMANCE. This view was six queries run strictly one after another, so the
       page waited for the sum of six round trips rather than the slowest one.
       Measured before changing anything:
         bridge_ledger select=*  192 kB  (the `extra` jsonb alone is 126 kB - 66%)
         attachments             76 kB
         audit_tasks             0 ROWS - the table is empty and has no writer in
                                 either API, so `task` was always undefined and
                                 auditStatus always fell through to p.audit_status.
       audit_tasks is dropped. The three that remain are independent, so they run in
       PARALLEL - the page now waits for the slowest, not the total. */
    const [atts, pays, comm] = await Promise.all([
      sbGet(s, 'attachments?select=id,client_no,payment_id,kind,doc_type,filename,carrier,amount,created_at,filed_hawksoft&order=created_at.desc&limit=1000'),
      sbGet(s, 'bridge_ledger?is_test=is.false&select=*&order=ts.desc&limit=500'),
      sbGet(s, 'agent_commission?select=*'),
    ]);
    // client names for the payments (dedupe client ids)
    const ids = [...new Set((pays.rows || []).map(p => p.client_id).filter(x => x != null))];
    const nameMap = {};
    const typeMap = {};   // per client: has ANY insurance, has ANY dmv (both possible)
    if (ids.length) {
      /* Both depend on the id list but not on each other. */
      const [cl, po] = await Promise.all([
        sbGet(s, `clients?client_no=in.(${ids.join(',')})&select=client_no,first_name,last_name,business_name`),
        sbGet(s, `policies?client_no=in.(${ids.join(',')})&select=client_no,record_type`),
      ]);
      for (const c of (cl.rows || [])) nameMap[c.client_no] = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
      for (const r of (po.rows || [])) {
        if (!typeMap[r.client_no]) typeMap[r.client_no] = { insurance: false, dmv: false };
        if (r.record_type === 'dmv_service') typeMap[r.client_no].dmv = true;
        else typeMap[r.client_no].insurance = true;
      }
    }
    const commMap = {}; for (const c of (comm.rows || [])) commMap[c.agent_email] = Number(c.percentage);

    const NON_PAYMENT_STATUS = ['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'];
    /* How much has been refunded off each payment. A refund row is NOT a work item —
       there is no carrier receipt to file for one, so it stays out of this queue — but
       the payment it came off must say what happened to it, or the Audit tab shows a
       $187.00 line that no longer exists as money. */
    const refundedOff = {};
    for (const p of (pays.rows || [])) {
      if (p.kind === 'charge_refund' && p.refund_of) {
        refundedOff[p.refund_of] = +((refundedOff[p.refund_of] || 0) + Math.abs(Number(p.amount || 0))).toFixed(2);
      }
    }
    let rows = (pays.rows || [])
      .filter(p => p.correction_status !== 'pending')
      .filter(p => !p.balance_of)   // rolled into the original charge, not a separate sale
      .filter(p => !NON_PAYMENT_STATUS.includes(p.audit_status)
                && !/declin|fail|void|refund/i.test(String(p.kind || '')))
      .map(p => {
      const dateStr = String(p.ts || '').slice(0, 10);
      const preAudit = dateStr < AUDIT_CUTOFF;
      const purpose = String(p.purpose || '').toLowerCase();
      let path = p.service_path;
      if (!path) {
        // 1) The charge's own purpose is the source of truth (agent picked "DMV" or wrote registration)
        if (purpose.includes('dmv') || purpose.includes('registration') || purpose.startsWith('regist')) path = 'dmv_service';
        // 2) Otherwise default to insurance. Only tag DMV-by-client if the client is DMV-ONLY (no insurance policies)
        else {
          const t = typeMap[p.client_id];
          if (t && t.dmv && !t.insurance) path = 'dmv_service';
          else path = 'insurance';
        }
      }
      const docs = (atts.rows || []).filter(a => (a.payment_id === p.id) || (a.client_no === p.client_id));
      /* audit_tasks was empty and unwritten, so this was always p.audit_status. */
      const auditStatus = preAudit ? 'pre_audit' : (p.audit_status || 'client_paid');
      const cost = p.service_cost != null ? Number(p.service_cost) : (p.carrier_paid_amount != null ? Number(p.carrier_paid_amount) : null);
      const fee = p.fee_amount != null ? Number(p.fee_amount) : (cost != null ? Number(p.amount) - cost : null);
      // Normalize agent identity: extract the email from the free-text agent string
      const emailMatch = String(p.agent || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const agentEmail = emailMatch ? emailMatch[0].toLowerCase() : (p.agent || 'unknown');
      const isAdmin = agentEmail === 'info@speedyins.com';
      const isSecureLink = /secure link/i.test(String(p.agent || ''));
      const pct = commMap[agentEmail] != null ? commMap[agentEmail] : 10;
      const commission = (fee != null && auditStatus === 'complete') ? +(fee * pct / 100).toFixed(2) : null;
      return {
        id: p.id, ts: p.ts, client_no: p.client_id,
        /* HOW MUCH OF THIS PAYMENT HAS GONE BACK. Zero for almost every row. Without it
           the Audit tab lists a $187.00 payment that is no longer $187.00 of money, and
           a refunded sale looks identical to one that stands. */
        refunded: refundedOff[p.id] || 0,
        client_notice: clientNoticeOf(p),
        client_name: nameMap[p.client_id] || (p.extra && p.extra.clientName) || null,
        amount: Number(p.amount), kind: p.kind, purpose: p.purpose, ref: p.ref,
        agent: agentEmail, agent_raw: p.agent, is_admin: isAdmin, secure_link: isSecureLink,
        path, audit_status: auditStatus, pre_audit: preAudit,
        total_owed: p.total_owed != null ? Number(p.total_owed) : null,
        collected: collectedFor(p, pays.rows || []),
        collected_ratio: collectedRatio(p, pays.rows || []),
        commission_to: p.commission_to || agentEmailOf(p.agent) || null,
        helper_email: p.helper_email || null,
        helper_share_pct: p.helper_share_pct != null ? Number(p.helper_share_pct) : null,
        share_locked_at: p.share_locked_at || null,
        receipt_pending: (p.kind === 'charge_captured') || !!(p.extra && p.extra.receipt_pending === true),
        /* task_id was always null: audit_tasks is empty and has no writer. I removed
           the declaration and MISSED this second use, which took the audit tab down.
           Grep every use of a name before deleting it, not just the one you read. */
        service_cost: cost, fee, pct, commission, doc_count: docs.length, task_id: null,
        /* The review trail the Audit tab reads: who submitted and when, the last
           send-back (kept on the row for good), and who approved. */
        audit_submitted_by: p.audit_submitted_by || null, audit_submitted_at: p.audit_submitted_at || null,
        audit_sendback: p.audit_sendback || null,
        audit_completed_by: p.audit_completed_by || null, audit_completed_at: p.audit_completed_at || null,
      };
    });
    const canApprove = await may(String(email).toLowerCase(), 'audit_approve');
    if (q) {
      rows = rows.filter(r =>
        String(r.client_no).includes(q) ||
        (r.client_name || '').toLowerCase().includes(q) ||
        (r.purpose || '').toLowerCase().includes(q) ||
        (r.ref || '').toLowerCase().includes(q) ||
        (r.agent || '').toLowerCase().includes(q) ||
        (r.path || '').toLowerCase().includes(q)
      );
    }
    return res.status(200).json({ ok: true, email, rows, attachments: atts.rows || [], commissions: comm.rows || [],
      can_approve: canApprove, names: AGENT_NAME, sendback_codes: AUDIT_SENDBACK_CODES });
  }

  if (view === 'agent_breakdown') {
    /* Group by who EARNS the commission, not who ran the charge. Grouping by charger
       made a reassigned payment show under the wrong agent — Angela Cervantes stayed
       under Jesus after he handed it to Sammy. */
    const agent = String(req.query.agent || '');
    const em = agentEmailOf(agent);
    const r = await sbGet(s, 'bridge_ledger?is_test=is.false&select=*&order=ts.desc&limit=500');
    const rows = (r.rows || []).filter(x => (x.commission_to || agentEmailOf(x.agent)) === em)
      .map(x => ({ ...x,
        charged_by: AGENT_NAME[agentEmailOf(x.agent)] || agentEmailOf(x.agent) || null,
        charged_by_other: agentEmailOf(x.agent) !== em }));
    return res.status(200).json({ ok: true, email, rows });
  }

  if (view === 'thumbs') {
    // Thumbnails for ONE payment's documents. Deliberately NOT in the audit list query:
    // that would ship a thumbnail for every attachment on every page load.
    const pid = String(req.query.payment_id || '');
    if (!pid) return res.status(400).json({ ok: false, error: 'payment_id required' });
    const r = await sbGet(s, `attachments?payment_id=eq.${encodeURIComponent(pid)}&select=id,thumb_b64`);
    return res.status(200).json({ ok: true, thumbs: (r.rows || []).filter(x => x.thumb_b64) });
  }

  /* The Console's document viewer. Same rule as portal_doc: the storage PATH is
     private and never leaves the server, so this returns bytes only. It used to
     hand back blob_url, which was harmless while that column was NULL on every row
     and becomes a leak the moment storage is live. */
  if (view === 'attachment_get') {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const r = await sbGet(s, `attachments?id=eq.${id}&select=filename,mime,file_b64,blob_url`);
    const a = (r.rows || [])[0];
    if (!a) return res.status(404).json({ ok: false, error: 'not found' });
    let file_b64 = a.file_b64 || null, served = a.file_b64 ? 'inline' : 'none';
    if (a.blob_url) {
      const got = await storageGet(a.blob_url);
      if (got) { file_b64 = got; served = 'storage'; }
    }
    if (!file_b64) return res.status(404).json({ ok: false, error: 'no bytes stored' });
    return res.status(200).json({ ok: true, filename: a.filename, mime: a.mime, file_b64, served });
  }

  if (view === 'pending_corrections') {
    const r = await sbGet(s, 'bridge_ledger?correction_status=eq.pending&is_test=is.false'
      + '&select=id,ts,client_id,amount,purpose,agent,correction_to_client,correction_requested_by,correction_requested_at,correction_note&order=correction_requested_at.desc');
    const rows = r.rows || [];
    const ids = [...new Set(rows.flatMap(x => [x.client_id, x.correction_to_client]).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const cl = await sbGet(s, `clients?client_no=in.(${ids.join(',')})&select=client_no,first_name,last_name,business_name`);
      for (const c of (cl.rows || [])) names[c.client_no] = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
    }
    return res.status(200).json({ ok: true, rows: rows.map(x => ({ ...x,
      from_name: names[x.client_id] || null, to_name: names[x.correction_to_client] || null })) });
  }

  if (view === 'health_check') {
    /* Money-vs-paperwork reconciliation. Every check here exists because a real bug
       reached production: proof filed without closing the audit, documents with no
       payment, the ledger id never returned, declines counted as money. Cutoffs matter
       — the receipt vault only began 2026-08-05, so earlier charges legitimately have
       no stored copy and must not be reported as faults. */
    const VAULT_START = '2026-08-05';
    const AUDIT_START = '2026-07-24';
    const TEST_CLIENT_ID = 26081; // ZZTEST fixture — no real money is ever taken on it
    const [led, att, testRows] = await Promise.all([
      sbGet(s, 'bridge_ledger?is_test=is.false&select=id,ts,client_id,amount,kind,audit_status,txn_id,carrier_name,carrier_paid_amount,carrier_zero_ack,purpose,service_cost,fee_amount,commission_to,agent&order=ts.desc&limit=1000'),
      sbGet(s, 'attachments?select=id,client_no,payment_id,kind,doc_type,filename,created_at&order=created_at.desc&limit=1000'),
      // deliberately NOT filtered by is_test — this check exists to find rows the filter misses
      sbGet(s, `bridge_ledger?client_id=eq.${TEST_CLIENT_ID}&is_test=is.false&select=id,ts,client_id,amount,kind,audit_status,commission_to,agent&order=ts.desc&limit=100`),
    ]);
    const rows = led.rows || [], docs = att.rows || [];
    const dtype = d => d.doc_type || d.kind || '';
    const docsFor = id => docs.filter(d => d.payment_id === id);
    const day = t => String(t || '').slice(0, 10);
    const money = r => Number(r.amount || 0);
    const issues = [];
    const add = (sev, title, why, list) => { if (list.length) issues.push({ sev, title, why, count: list.length, rows: list.slice(0, 25) }); };
    const brief = r => ({ id: r.id, ts: r.ts, client_no: r.client_id, amount: money(r), kind: r.kind,
                          agent: r.commission_to || r.agent, audit_status: r.audit_status });

    // 1) proof is on file but the audit never closed — the bug that hid Sammy's work
    add('high', 'Proof on file, audit still open',
      'A carrier receipt exists but the payment is not marked complete, so no fee or commission was recorded.',
      /* ready_for_audit is excluded: that row is waiting for an approver, which is the
         process working, not the bug this issue was written for. */
      rows.filter(r => ['client_paid','carrier_pending'].includes(r.audit_status) && !r.audit_submitted_at
        && docsFor(r.id).some(d => dtype(d) === 'carrier_receipt')).map(brief));

    // 2) documents floating free of any payment
    const orphans = docs.filter(d => !d.payment_id);
    if (orphans.length) issues.push({ sev: 'high', title: 'Documents not linked to a payment',
      why: 'These files are stored against the client but not against a charge, so they cannot close an audit.',
      count: orphans.length,
      rows: orphans.slice(0, 25).map(d => ({ id: d.id, ts: d.created_at, client_no: d.client_no, filename: d.filename, kind: dtype(d) })) });

    // 3) money captured with no receipt stored (only since the vault existed)
    add('high', 'Charge with no receipt stored',
      'Money was captured but no Speedy receipt PDF is on file for it.',
      rows.filter(r => r.txn_id && day(r.ts) >= VAULT_START
        && !docsFor(r.id).some(d => dtype(d) === 'client_receipt')).map(brief));

    // 4) completed audits missing their numbers
    add('high', 'Audit complete but figures missing',
      'Marked complete without a carrier cost or fee — commission cannot be calculated.',
      rows.filter(r => r.audit_status === 'complete' && (r.fee_amount == null || r.service_cost == null)).map(brief));

    // 5) nobody owns the commission
    add('med', 'Payment with no commission owner',
      'No agent is credited, so it will not appear in anyone\'s queue.',
      rows.filter(r => !r.commission_to && ['client_paid','carrier_pending','ready_for_audit','complete'].includes(r.audit_status)).map(brief));

    // 6) a fee bigger than the charge means the numbers were entered wrongly
    add('high', 'Carrier cost exceeds what the client paid',
      'The carrier cost is higher than the payment, which produces a negative fee.',
      rows.filter(r => r.service_cost != null && Number(r.service_cost) > money(r) + 0.005).map(brief));

    // 7) possible double charge
    const dupes = [];
    for (const a of rows) {
      if (!a.txn_id) continue;
      for (const b of rows) {
        if (a.id >= b.id || !b.txn_id) continue;
        if (a.client_id === b.client_id && Math.abs(money(a) - money(b)) < 0.005
            && Math.abs(new Date(a.ts) - new Date(b.ts)) < 2 * 3600 * 1000) dupes.push(brief(a));
      }
    }
    add('high', 'Possible duplicate charge', 'Same client, same amount, both captured within two hours.', dupes);

    // 8) work waiting too long
    add('med', 'Open more than 14 days',
      'Payments still without proof after two weeks.',
      rows.filter(r => r.audit_status === 'client_paid' && day(r.ts) >= AUDIT_START
        && (Date.now() - new Date(r.ts)) > 14 * 86400000).map(brief));

    /* 9) test money counted as real.
       is_test is read in 9 places but for a long time nothing wrote it: the column
       default is false, so the early rows had been flagged BY HAND. Once that stopped,
       ZZTEST charges became real revenue, real commission, and phantom unfinished
       audits in agents' queues. Every other check on this page filters is_test out,
       which is exactly why this one must not. */
    add('high', 'Test charge counted as real money',
      `Payments on the ZZTEST fixture (#${TEST_CLIENT_ID}) that are not flagged as test. They inflate revenue, credit commission nobody earned, and sit in an agent's unfinished queue.`,
      (testRows.rows || []).map(brief));

    /* 10) a column nothing appears to write.
       The recurring failure in this codebase is a column with a DEFAULT and no writer:
       audit_status defaulted to client_paid, is_test defaulted to false. It reads as a
       real value, so nothing looks wrong until the numbers are wrong. A column that
       never varies across hundreds of rows is the data-side signature of that bug.
       This is a HINT, not proof — a column can be legitimately constant. */
    const NEVER_VARIES_WATCH = ['audit_status', 'kind', 'commission_to'];
    const stuck = [];
    if (rows.length >= 50) {
      for (const col of NEVER_VARIES_WATCH) {
        const seen = new Set(rows.map(r => (r[col] === undefined || r[col] === null) ? '\u2205' : String(r[col])));
        if (seen.size === 1) {
          // shaped to use the renderer's filename branch, so it prints as a sentence
          // rather than as "$0.00 · column"
          stuck.push({ id: col, ts: null, client_no: null,
                       filename: `${col} — all ${rows.length} recent payments read "${[...seen][0]}"`,
                       agent: '' });
        }
      }
    }
    add('med', 'Column never varies — may have no writer',
      'Across every recent payment this column holds one single value. Usually that means code reads it but nothing sets it, so it is silently sitting at its database default.',
      stuck);

    /* 11) a zero the agent confirmed, on a purpose where zero is suspicious.
       Zero carrier cost is legitimate — endorsements and cancellations often cost the
       agency nothing — so the form allows it behind a checkbox rather than refusing it.
       A gate that refuses a legitimate case does not stop the agent, it makes them type
       0.01. But a down payment with nothing paid to the carrier is a different claim,
       and it belongs in review here rather than as a block at the counter. */
    const zeroCents = r => r.carrier_paid_amount != null && Number(r.carrier_paid_amount) === 0;
    add('med', 'Zero carrier cost confirmed on a down payment',
      'The agent ticked "the agency paid $0.00" on a down payment. That is legitimate on an endorsement or cancellation but unusual here — check the paperwork before the fee stands.',
      rows.filter(r => r.carrier_zero_ack === true && String(r.purpose || '').toLowerCase().startsWith('down payment')).map(brief));

    /* 12) a zero nobody confirmed.
       This is the reason carrier_zero_ack exists. A confirmed 0.00 and a 0.00 written by
       a bug are the same number; only the flag tells them apart. Rows from before the
       flag existed are excluded by ZERO_ACK_START — they predate the question. */
    const ZERO_ACK_START = '2026-08-21';
    add('high', 'Zero carrier cost with no acknowledgement',
      'The carrier amount is 0.00 but no agent confirmed it. Either the acknowledgement was bypassed or something wrote a zero on its own — the second is the failure this flag exists to catch.',
      rows.filter(r => zeroCents(r) && r.carrier_zero_ack !== true && day(r.ts) >= ZERO_ACK_START).map(brief));

    const worst = issues.some(i => i.sev === 'high') ? 'attention' : issues.length ? 'minor' : 'clean';
    return res.status(200).json({ ok: true, status: worst, checked: rows.length,
      documents: docs.length, checked_at: new Date().toISOString(), issues });
  }

  /* ---------- Ops console summary ----------
     Sits behind the SAME verifyGoogle gate as every other admin view above; that
     gate is deliberately not touched. Everything the ops page shows comes from here
     rather than being baked into the HTML, because static files under /admin/ are
     fetchable by anyone with the URL - an unauthenticated fetch of ops.html must
     return a page that says nothing.

     COUNTS AND STATUS ONLY. No client names, no amounts, no policy numbers, and
     never a credential. Links point at dashboards; keys stay in Vercel env. */
  /* One-time re-send. The nine payments linked at 14:37 today had their HawkSoft
     notes rejected (array instead of object) and have already moved past
     'no policy # given', so the sweep will not revisit them. Re-sends from the
     payment.policy_linked events, which hold everything needed. Idempotent by
     intent: skips any payment that already has a successful note recorded. */
  /* A receipt filed against the WRONG policy. HawkSoft has no receipt-modify
     endpoint, so it cannot be moved - the only honest remedy is a note on BOTH tabs
     so neither reader is misled: the tab holding the receipt says it does not belong
     there, and the tab that should have it says where it actually sits.

     Deliberately generic and admin-only. This will happen again, and a one-off script
     for 7941 would have to be rewritten next time. */
  if (view === 'note_wrong_policy') {
    const q = req.query;
    const clientNo = parseInt(q.client, 10);
    const amount = Number(q.amount);
    const wrongGuid = String(q.wrong_guid || '').trim();
    const rightGuid = String(q.right_guid || '').trim();
    const wrongLabel = String(q.wrong_label || 'the policy it was filed against');
    const rightLabel = String(q.right_label || 'the correct policy');
    const when = String(q.when || '');
    if (!clientNo || !isFinite(amount) || !wrongGuid || !rightGuid) {
      return res.status(400).json({ ok: false,
        error: 'client, amount, wrong_guid, right_guid required' });
    }
    const send = (guid, text) => hsCall(`/vendor/agency/${AGENCY_ID}/client/${clientNo}/log?version=4.0`, {
      method: 'POST',
      body: JSON.stringify({ refId: crypto.randomUUID(), ts: new Date().toISOString(),
                             channel: 32, note: text.slice(0, 3000), policyId: guid }),
    });
    const money = '$' + amount.toFixed(2);
    const a = await send(wrongGuid,
      `CORRECTION — the ${money} receipt on this policy${when ? ' (taken ' + when + ')' : ''} `
      + `does NOT belong here. It was filed against this tab in error and should sit on `
      + `${rightLabel}. HawkSoft receipts cannot be moved once filed, so the receipt stays `
      + `on this tab; treat ${rightLabel} as the policy this payment paid for.`);
    const b = await send(rightGuid,
      `${money} was paid for THIS policy${when ? ' on ' + when : ''}, but the receipt was `
      + `filed against ${wrongLabel} in error and cannot be moved - HawkSoft has no way to `
      + `re-file a receipt. The money is recorded; the receipt is simply on the wrong tab.`);
    const okA = a && (a.status === 200 || a.status === 202);
    const okB = b && (b.status === 200 || b.status === 202);
    if (okA || okB) {
      await sbInsert(sb(), 'events', [{ actor: email, kind: 'payment.wrong_policy_noted',
        client_no: clientNo, source: 'manual',
        payload: { amount, wrong_guid: wrongGuid, right_guid: rightGuid,
                   wrong_label: wrongLabel, right_label: rightLabel,
                   note_on_wrong_tab: okA, note_on_right_tab: okB } }]);
    }
    return res.status(200).json({ ok: okA && okB,
      note_on_wrong_tab: { ok: okA, status: a && a.status },
      note_on_right_tab: { ok: okB, status: b && b.status } });
  }

  if (view === 'resend_policy_notes') {
    const s = sb();
    const ev = await sbGet(s, `events?kind=eq.payment.policy_linked&select=client_no,payload,ts&order=ts.asc&limit=100`);
    const done = await sbGet(s, `events?kind=eq.payment.note_sent&select=payload&limit=200`);
    const already = new Set((done.rows || []).map(r => r.payload && r.payload.payment_id).filter(Boolean));
    const out = { attempted: 0, sent: 0, failed: [], skipped: 0 };
    for (const e of (ev.rows || [])) {
      const q = e.payload || {};
      if (!q.payment_id) continue;
      if (already.has(q.payment_id)) { out.skipped++; continue; }
      out.attempted++;
      try {
        const when = new Date(q.charged_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
        const note =
          `$${Number(q.amount).toFixed(2)} down payment taken ${when} filed at CLIENT LEVEL — `
          + `the policy had not been issued yet, and HawkSoft receipts cannot be moved afterwards. `
          + `This payment bought ${q.policy_number || '(policy number pending)'}`
          + (q.carrier ? ` — ${q.carrier}` : '')
          + `. Matched automatically by the Speedy platform when the policy synced.`;
        const lr = await hsCall(`/vendor/agency/${AGENCY_ID}/client/${e.client_no}/log?version=4.0`, {
          method: 'POST',
          body: JSON.stringify({ refId: crypto.randomUUID(), ts: new Date().toISOString(),
                                 channel: 32, note: note.slice(0, 3000) }),
        });
        if (lr && (lr.status === 200 || lr.status === 202)) {
          out.sent++;
          await sbInsert(s, 'events', [{ actor: email, kind: 'payment.note_sent',
            client_no: e.client_no, source: 'hawksoft_sync',
            payload: { payment_id: q.payment_id, policy_number: q.policy_number, resent: true } }]);
        } else {
          out.failed.push({ client_no: e.client_no, status: lr && lr.status,
                            body: JSON.stringify(lr && lr.body).slice(0, 200) });
        }
      } catch (err) { out.failed.push({ client_no: e.client_no, error: String(err).slice(0, 160) }); }
    }
    return res.status(200).json({ ok: true, ...out });
  }

  /* ---------- TRUST LEDGER ----------
     Premium collected, what went to carriers, what Speedy kept - built ENTIRELY from
     our own tables. Clover reports the charge, the agent enters the carrier cost, the
     fee is the difference. HawkSoft contributes nothing to any figure here; it only
     ever receives a copy of the receipt afterwards. So this is independent of it by
     construction, not by migration.

     WHAT THIS IS: a report over data we already own.
     WHAT THIS IS NOT: the book of record. `service_cost` is what the AGENT recorded
     paying a carrier, evidenced by an attached receipt - it is not a bank movement.
     Real trust accounting reconciles to the bank on both sides, and Clover deposits
     do not match charges (processing fees come out, batches settle on different days,
     refunds net off). Until that reconciliation exists this is an accurate picture of
     what was collected and owed, and an estimate of cash position. California DOI
     rules make being wrong here a compliance problem rather than a bug, so the
     distinction is stated rather than assumed.

     UNACCOUNTED is the number to act on: money collected where no carrier cost has
     been entered. It is not a hole in the data - every dollar has an agent and an
     unfinished audit behind it. */
  if (view === 'trust') {
    const s = sb();
    /* periodBounds lives inside portal_home at depth 3 and is NOT visible here - the
       same scope mistake as PT_DAY, loadRoster and nowIso. Rather than move a function
       the earnings figures depend on, the month boundary is computed here, in Pacific,
       by the same rule: the offset is MEASURED for the date so PST and PDT both land
       correctly. */
    const ptParts = d => {
      const [y, m, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-').map(Number);
      return { y, m, d: dd };
    };
    const ptMidnightUTC = (y, m, dd) => {
      const probe = new Date(Date.UTC(y, m - 1, dd, 12, 0, 0));
      const hh = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
        hour: '2-digit', hour12: false }).format(probe));
      return new Date(Date.UTC(y, m - 1, dd, 12 - hh, 0, 0)).toISOString();
    };
    const nowT = ptParts(new Date());
    const period = (String(req.query.period || 'this') === 'last')
      ? (() => { const ly = nowT.m === 1 ? nowT.y - 1 : nowT.y, lm = nowT.m === 1 ? 12 : nowT.m - 1;
                 return { from: ptMidnightUTC(ly, lm, 1), to: ptMidnightUTC(nowT.y, nowT.m, 1),
                          label: ly + '-' + String(lm).padStart(2, '0') }; })()
      : { from: ptMidnightUTC(nowT.y, nowT.m, 1), to: null,
          label: nowT.y + '-' + String(nowT.m).padStart(2, '0') };

    /* balance_of and total_owed are needed for the partial-payment arithmetic below.
       Neither was selected, which is why a balance payment landed in "unaccounted". */
    const rows = (await sbGet(s, 'bridge_ledger?is_test=is.false'
      + '&select=id,ts,client_id,amount,purpose,agent,commission_to,audit_status,'
      + 'service_cost,fee_amount,carrier_name,kind,audit_completed_at,balance_of,total_owed'
      + '&order=ts.desc&limit=2000')).rows || [];

    /* Only real, collected money. A declined attempt never moved a cent, and a pay
       link that was merely sent is not a payment. */
    const collected = rows.filter(r =>
      ['charge_live', 'charge_cash', 'paylink_charge', 'terminal_charge'].includes(r.kind)
      && !/declin|fail|void|refund/i.test(String(r.kind || ''))
      && String(r.ts) >= period.from && (!period.to || String(r.ts) < period.to));

    /* ---- REFUNDS. The `collected` filter above is a closed list of four kinds, so a
       charge_refund row is invisible to it — which is exactly the trap recorded in
       MASTER.md: left alone, a refund would never reduce anything here and Trust would
       keep reporting money that has gone back to the client as profit.

       The arithmetic, and it balances:
         · the money returned comes off what Speedy holds;
         · the fee recognised on the parent is reversed — nothing is kept on a sale that
           was given back;
         · the carrier's share depends on the answer the agent gave.
             yes     -> the carrier returns it, so the cost reverses too and the payment
                        nets to nothing.
             no      -> the carrier keeps its premium and the client got everything back,
                        so the difference is money SPEEDY HAS LOST. Trust had no line for
                        that: it could show money in, money to carriers and money kept,
                        but not money simply gone.
             pending -> the same arithmetic as `no` today, because the money is not back
                        yet, but tracked separately so it can be chased.
       The invariant, which the harness asserts rather than trusting this comment:
         collected - refunded + not_yet_collected + carrier_loss = carriers + kept + unaccounted */
    const refunds = rows.filter(r => r.kind === 'charge_refund'
      && String(r.ts) >= period.from && (!period.to || String(r.ts) < period.to));
    const byId = new Map(rows.map(r => [r.id, r]));

    const money = v => Math.round(Number(v || 0) * 100) / 100;
    let inTotal = 0, toCarriers = 0, kept = 0, unaccounted = 0, notYetCollected = 0;
    let refunded = 0, carrierLost = 0, carrierToRecover = 0;
    const byCarrier = {}, openItems = [], refundItems = [];

    for (const r of collected) {
      const amt = Number(r.amount) || 0;
      inTotal += amt;

      /* ---- A BALANCE PAYMENT IS NOT UNATTRIBUTED MONEY ----
         It pays down an earlier charge, and that charge already carries the carrier
         cost and the single fee for the whole sale. This row has no service_cost of
         its own and never will, because it carries no audit — so the old
         `service_cost == null` test dropped it into "unaccounted", where it would sit
         FOREVER: $121.00 across two rows measured Sep 10. It is collected money whose
         attribution lives on the parent, so it counts in the total and nowhere else. */
      if (r.balance_of) continue;

      if (r.service_cost == null) {
        /* Collected, but nobody has said how much of it belongs to a carrier. Until
           they do, the whole amount is unattributed - it is NOT profit. */
        unaccounted += amt;
        openItems.push({ id: r.id, client_no: r.client_id, amount: money(amt),
          purpose: r.purpose, ts: r.ts, audit_status: r.audit_status,
          agent: r.commission_to || r.agent || null });
        continue;
      }
      const cost = Number(r.service_cost) || 0;
      const fee = r.fee_amount != null ? Number(r.fee_amount) : (amt - cost);
      toCarriers += cost; kept += fee;
      /* ---- WHY THE THREE BUCKETS EXCEED WHAT CAME IN ----
         Since A, the carrier cost and the fee are the figures for the WHOLE
         obligation, so a part-payment recognises more than it collected. Measured
         Sep 10: the three buckets exceeded collected by exactly $141.00, which was
         exactly the sum of (owed - amount) across the two part-payments. That is not
         an error, it is receivable — but it was invisible, so the tab appeared not to
         add up. Named and returned instead of left as a silent discrepancy.

         The invariant is therefore NOT collected = carriers + kept + unaccounted. It
         is:  collected + not_yet_collected = carriers + kept + unaccounted. */
      const owed = (r.total_owed != null && Number(r.total_owed) > amt) ? Number(r.total_owed) : amt;
      notYetCollected += (owed - amt);

      const name = r.carrier_name || '(carrier not named)';
      if (!byCarrier[name]) byCarrier[name] = { carrier: name, payments: 0, collected: 0, to_carrier: 0, fees: 0 };
      const c = byCarrier[name];
      c.payments++; c.collected += amt; c.to_carrier += cost; c.fees += fee;
    }
    /* A balance payment that has ARRIVED reduces the receivable, so it comes off the
       not-yet-collected figure — its parent is where the obligation was recognised. */
    for (const r of collected) if (r.balance_of) notYetCollected -= (Number(r.amount) || 0);
    if (notYetCollected < 0) notYetCollected = 0;

    for (const r of refunds) {
      const back = Math.abs(Number(r.amount) || 0);
      refunded += back;
      const parent = byId.get(r.refund_of) || null;
      /* The fee is reversed whatever the carrier says: Speedy keeps nothing on a sale
         it gave back. Read off the REFUND row, which carries -parentFee, so this and
         the commission reversal can never disagree. */
      const feeBack = r.fee_amount != null ? Math.abs(Number(r.fee_amount)) : 0;
      kept -= feeBack;
      const cost = parent && parent.service_cost != null ? Number(parent.service_cost) : 0;
      if (r.refund_carrier === 'yes') {
        toCarriers -= cost;                 // the carrier gave its share back too
      } else if (r.refund_carrier === 'no') {
        carrierLost += cost;                // gone. the line Trust never had
      } else {
        carrierToRecover += cost;           // not back yet, and nothing chases it alone
      }
      refundItems.push({ id: r.id, payment_id: r.refund_of, client_no: r.client_id,
        amount: money(back), ts: r.ts, reason: r.refund_reason || null,
        carrier: r.refund_carrier || null, carrier_name: parent ? (parent.carrier_name || null) : null,
        carrier_cost: money(cost), fee_reversed: money(feeBack),
        agent: r.commission_to || r.agent || null, note: r.refund_note || null });
    }

    return res.status(200).json({
      ok: true,
      period: period.label, period_from: period.from, period_to: period.to,
      source: 'Speedy platform only — no HawkSoft data is used in any figure below.',
      totals: {
        payments: collected.length,
        collected: money(inTotal),
        to_carriers: money(toCarriers),
        speedy_kept: money(kept),
        unaccounted: money(unaccounted),
        unaccounted_count: openItems.length,
        /* Gross in, and what went back out, kept as SEPARATE lines. Netting them into
           `collected` would silently change the meaning of a number Saif already
           reads every day. */
        refunded: money(refunded),
        refunds_count: refunds.length,
        net_collected: money(inTotal - refunded),
        /* Money the carrier kept on a sale that was refunded in full. NOT recoverable. */
        carrier_lost: money(carrierLost),
        /* The same shape, but the carrier has not answered yet. This is a queue, and
           nothing chases it on its own — the same failure mode as a carrier_pending
           audit, which is how a $141.00 gap sat unnoticed here. */
        carrier_to_recover: money(carrierToRecover),
        /* Recognised but not in the till yet: the part of an obligation still owed on
           charges whose full carrier cost and fee have already been counted above.
           This is what makes the three buckets exceed `collected`. */
        not_yet_collected: money(notYetCollected),
      },
      by_carrier: Object.values(byCarrier)
        .map(c => ({ ...c, collected: money(c.collected), to_carrier: money(c.to_carrier), fees: money(c.fees) }))
        .sort((a, b) => b.to_carrier - a.to_carrier),
      unaccounted_items: openItems.sort((a, b) => b.amount - a.amount).slice(0, 50),
      caveat: 'service_cost is what the agent recorded paying a carrier, evidenced by an '
            + 'attached receipt — not a bank movement. Reconciliation against Clover '
            + 'deposits and the bank is not built, so treat cash position as an estimate.',
    });
  }

  if (view === 'ops_summary') {
    const s = sb();
    const num = r => Number((r.rows && r.rows[0] && r.rows[0].n) || 0);
    const cnt = async (path) => {
      try {
        const r = await sbGet(s, path + '&select=count');
        return Number((r.rows && r.rows[0] && r.rows[0].count) || 0);
      } catch { return null; }
    };
    const cutoff = '2026-07-29';
    const [openAudits, docsTotal, docsInStorage, docsInline, agentsActive, ledger30, auditsWaiting] = await Promise.all([
      cnt(`bridge_ledger?audit_status=neq.complete&is_test=is.false&ts=gte.${cutoff}`),
      cnt('attachments?id=not.is.null'),
      cnt('attachments?blob_url=not.is.null'),
      cnt('attachments?file_b64=not.is.null'),
      cnt('agents?active=is.true'),
      cnt(`bridge_ledger?is_test=is.false&ts=gte.${new Date(Date.now() - 30 * 864e5).toISOString()}`),
      cnt('bridge_ledger?audit_status=eq.ready_for_audit&is_test=is.false'),
    ]);
    let lastSync = null;
    try {
      const r = await sbGet(s, 'events?kind=eq.sync.delta&select=ts&order=ts.desc&limit=1');
      lastSync = (r.rows && r.rows[0] && r.rows[0].ts) || null;
    } catch {}
    /* GBP: last 90 days of gbp_runs, reduced to what the console shows. A failed read
       is reported as gbp:null and the page says so - it must never show zeros that
       mean "could not read" as if they meant "nothing happened". */
    let gbp = null;
    try {
      const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
      const r = await sbGet(s, `gbp_runs?run_date=gte.${since}&kind=neq.warmup&select=run_date,kind,run_by,replies,posts,for_saif,notes&order=run_date.asc,id.asc`);
      gbp = gbpSummary(r.rows || []);
    } catch {}
    return res.status(200).json({
      ok: true,
      gbp,
      generated: new Date().toISOString(),
      live: {
        open_audits: openAudits,
        documents: docsTotal,
        documents_in_storage: docsInStorage,
        documents_inline: docsInline,
        agents_active: agentsActive,
        payments_30d: ledger30,
        last_client_sync: lastSync,
        audits_waiting: auditsWaiting,
      },
      versions: OPS_VERSIONS,
      costs: OPS_COSTS,
      links: OPS_LINKS,
      sections: OPS_SECTIONS,
      decisions: OPS_DECISIONS,
      recurring: OPS_RECURRING,
      platform_map: OPS_PLATFORM_MAP,
    });
  }

  if (view === 'system_health') {
    // Call the Postgres RPC for sizes
    let health = null;
    try {
      const r = await fetch(`${s.base}/rest/v1/rpc/system_health`, {
        method: 'POST', headers: { ...s.hdrs }, body: '{}',
      });
      health = await r.json();
    } catch (e) { return res.status(500).json({ ok: false, error: 'health query failed' }); }

    const dbBytes = Number(health.db_bytes || 0);
    const attBytes = Number(health.attachments_bytes || 0);
    // Supabase tier limits (Pro = 8GB disk; warn well before)
    const DB_WARN = 6 * 1024 ** 3;      // 6 GB — start planning
    const DB_CRIT = 7.5 * 1024 ** 3;    // 7.5 GB — act now (Pro cap 8GB)
    const ATT_WARN = 500 * 1024 ** 2;   // 500 MB inline attachments — move to Blob
    const ATT_CRIT = 1024 ** 3;         // 1 GB inline — urgent

    const alerts = [];
    if (dbBytes >= DB_CRIT) alerts.push({ level: 'critical', msg: 'Database near tier cap — upgrade Supabase or archive data now.' });
    else if (dbBytes >= DB_WARN) alerts.push({ level: 'warn', msg: 'Database growing — plan capacity (Supabase Pro = 8GB).' });
    if (attBytes >= ATT_CRIT) alerts.push({ level: 'critical', msg: 'Inline attachments over 1GB — move receipt PDFs to Blob storage.' });
    else if (attBytes >= ATT_WARN) alerts.push({ level: 'warn', msg: 'Inline attachments over 500MB — consider moving PDFs to Blob storage.' });

    return res.status(200).json({
      ok: true, email,
      db_bytes: dbBytes, attachments_bytes: attBytes,
      attachment_count: health.attachment_count || 0,
      tables: health.tables || [],
      thresholds: { db_warn: DB_WARN, db_crit: DB_CRIT, att_warn: ATT_WARN, att_crit: ATT_CRIT },
      alerts, generated_at: health.generated_at,
    });
  }

  if (view === 'sync_status') {
    const st = await sbGet(s, 'sync_state?key=eq.hawksoft_clients&select=*');
    const ev = await sbGet(s, "events?kind=eq.sync.completed&select=ts,payload&order=ts.desc&limit=5");
    // live job progress from sync_jobs
    const running = await sbGet(s, "sync_jobs?status=in.(pending,running)&select=id,kind,status,total,processed,clients_updated,policies_updated,created_at,updated_at&order=created_at.desc&limit=1");
    const lastDone = await sbGet(s, "sync_jobs?status=eq.complete&select=id,kind,total,processed,clients_updated,policies_updated,created_at,updated_at&order=updated_at.desc&limit=1");
    const job = (running.rows || [])[0] || null;
    const done = (lastDone.rows || [])[0] || null;
    return res.status(200).json({
      ok: true, email,
      state: (st.rows || [])[0] || null, recent: ev.rows || [],
      job, last_complete: done,
    });
  }



  /* ---- Ledger ---- */
  if (view === 'ledger') {
    const r = await sbGet(s, 'bridge_ledger?select=*&order=ts.desc&limit=50');
    return res.status(200).json({ ok: r.ok, email, rows: r.rows || [] });
  }

  /* ---- Recording probe (read-only, diagnostic) ----
     Telephony session events do NOT carry recording IDs — 10 days of webhook
     data has zero. Recordings live on the call-log API instead. This proves
     they exist and are fetchable BEFORE any storage gets built. */
  if (view === 'rec_probe') {
    const RC = (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
    try {
      const basic = Buffer.from(process.env.RC_CLIENT_ID + ':' + process.env.RC_CLIENT_SECRET).toString('base64');
      const ar = await fetch(RC + '/restapi/oauth/token', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: process.env.RC_JWT,
        }),
      });
      const aj = await ar.json().catch(() => ({}));
      if (!ar.ok) return res.status(200).json({ ok: false, step: 'auth', status: ar.status, detail: aj.error_description || aj.error });

      const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 48));
      const from = new Date(Date.now() - hours * 3600000).toISOString();

      const lr = await fetch(RC + '/restapi/v1.0/account/~/call-log'
        + '?dateFrom=' + encodeURIComponent(from)
        + '&recordingType=All&perPage=25&view=Detailed', {
        headers: { Authorization: 'Bearer ' + aj.access_token },
      });
      const lj = await lr.json().catch(() => ({}));
      if (!lr.ok) return res.status(200).json({ ok: false, step: 'call-log', status: lr.status, detail: lj.message || lj.errorCode });

      const recs = (lj.records || []).filter(r => r.recording && r.recording.id);

      return res.status(200).json({
        ok: true,
        windowHours: hours,
        callsReturned: (lj.records || []).length,
        withRecording: recs.length,
        verdict: recs.length
          ? 'Recordings ARE available — safe to build the pull.'
          : 'No recordings in this window. Either recording is not enabled on these extensions, or nothing recorded recently. Check Admin Portal > Call Recording before building.',
        sample: recs.slice(0, 3).map(r => ({
          telephonySessionId: r.telephonySessionId,
          startTime: r.startTime,
          durationSec: r.duration,
          direction: r.direction,
          recordingId: r.recording.id,
          recordingType: r.recording.type,
          hasContentUri: !!r.recording.contentUri,
        })),
      });
    } catch (e) {
      return res.status(200).json({ ok: false, step: 'exception', detail: String(e.message || e) });
    }
  }

  /* ---- Calls (RingCentral) ---- */
  if (view === 'call_legs') {
    const sid = String(req.query.session || '');
    if (!sid) return res.status(400).json({ ok: false, error: 'Missing session' });
    const r = await sbGet(s,
      'call_log?rc_session_id=eq.' + encodeURIComponent(sid) +
      '&select=rc_party_id,direction,from_number,to_number,agent_name,result,' +
      'status_code,disconnect_reason,started_at,answered_at,ended_at,duration_seconds' +
      '&order=rc_party_id.asc');
    return res.status(200).json({ ok: r.ok, email, legs: r.rows || [] });
  }

  if (view === 'calls') {
    const OFFICES = { 1: 'Moreno Valley', 2: 'Riverside — Van Buren', 3: 'Riverside — Magnolia', 4: 'Lake Elsinore' };
    const pretty = p => (p && p.length === 10) ? `(${p.slice(0,3)}) ${p.slice(3,6)}-${p.slice(6)}` : (p || '');

    const days = Math.min(90, Math.max(1, Number(req.query.days) || 1));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    let path = 'call_sessions?or=(ring_start.gte.' + since + ',call_end.gte.' + since + ')' +
               '&order=ring_start.desc.nullslast&limit=500';
    if (req.query.outcome) path += '&outcome=eq.' + encodeURIComponent(String(req.query.outcome));
    if (req.query.office)  path += '&office_id=eq.' + encodeURIComponent(String(req.query.office));

    const r = await sbGet(s, path);
    const rows = Array.isArray(r.rows) ? r.rows : [];

    const calls = rows.map(c => ({
      ...c,
      customer_pretty: pretty(c.customer_number),
      office_name: OFFICES[c.office_id] || (c.office_id ? 'Office ' + c.office_id : null),
    }));

    const answered = calls.filter(c => c.outcome === 'Answered');
    const talk = answered.reduce((n, c) => n + (Number(c.talk_seconds) || 0), 0);

    const byAgent = {};
    for (const c of calls) {
      if (c.answered_by) {
        const a = (byAgent[c.answered_by] ||= { agent: c.answered_by, answered: 0, talk: 0, missedWhileRinging: 0 });
        a.answered += 1; a.talk += Number(c.talk_seconds) || 0;
      }
      for (const name of (c.rang_agents || [])) {
        (byAgent[name] ||= { agent: name, answered: 0, talk: 0, missedWhileRinging: 0 }).missedWhileRinging += 1;
      }
    }

    return res.status(200).json({
      ok: r.ok, email, days,
      stats: {
        total: calls.length,
        answered: answered.length,
        missed: calls.length - answered.length,
        answerRate: calls.length ? Math.round(answered.length / calls.length * 100) : 0,
        talkSeconds: talk,
        avgTalk: answered.length ? Math.round(talk / answered.length) : 0,
        matched: calls.filter(c => c.matched).length,
      },
      agents: Object.values(byAgent).sort((a, b) => b.answered - a.answered),
      calls,
    });
  }

  /* ---- Table inventory ---- */
  if (view === 'tables') {
    const known = ['clients', 'policies', 'policy_detail', 'events', 'extractions', 'bridge_ledger', 'clover_tokens'];
    const out = [];
    for (const t of known) {
      const r = await fetch(`${s.base}/rest/v1/${t}?select=*&limit=1`, { headers: { ...s.hdrs, Prefer: 'count=exact' } });
      const range = r.headers.get('content-range') || '';
      const count = range.includes('/') ? Number(range.split('/')[1]) : null;
      const sample = await r.json().catch(() => []);
      out.push({ table: t, exists: r.ok, rows: isFinite(count) ? count : null, columns: Array.isArray(sample) && sample[0] ? Object.keys(sample[0]) : [] });
    }
    return res.status(200).json({ ok: true, email, tables: out });
  }

  return res.status(400).json({ ok: false, error: 'Unknown view' });
}


