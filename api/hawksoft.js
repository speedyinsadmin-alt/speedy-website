export const config = { maxDuration: 60 };
import { createHmac } from 'node:crypto';
// /api/hawksoft — server-side proxy to the HawkSoft Partner API (v4.0).
// Reads HAWKSOFT_CLIENT_ID + HAWKSOFT_SECRET from Vercel env vars.
//
// GET  → non-PII aggregates (status, scopes, offices, client counts). No auth beyond deploy.
// POST → Test Lab / write actions. REQUIRES header  x-admin-key: <ADMIN_API_KEY env var>.
//        Actions: create_test_client, add_log, lookup_client (returns MASKED field shapes only).

const AGENCY_ID = 15112;
/* Producer code -> agent. Lives in OUR system, not HawkSoft: the codes are synced into
   the clients table, so commission attribution keeps working when HawkSoft is retired. */
const PRODUCER_MAP = {
  SSM: 'sammy@speedyins.com',     JEV: 'jesus@speedyins.com',   THD: 'info@speedyins.com',
  AES: 'alejandra@speedyins.com', YVA: 'yasmin@speedyins.com',  LIF: 'lfigueroa@speedyins.com',
  JLR: 'jorge@speedyins.com',     CMA: 'chris@speedyins.com',   YYH: 'yolanda@speedyins.com',
  FSS: 'fernando@speedyins.com',  EHA: 'esmeralda@speedyins.com',
};
const STAFF_EMAILS = Object.values(PRODUCER_MAP).concat(['irene@speedyins.com', 'melisa@speedyins.com', 'tony@speedyins.com', 'lana@speedyins.com']);
function normaliseAgentEmail(v) {
  const m = String(v || '').match(/[A-Za-z0-9._%+-]+@speedyins\.com/i);
  return m ? m[0].toLowerCase() : null;
}

/* SINGLE SOURCE for reading a money value off the wire.
   parseFloat('1,602.40') === 1 — a typed or pasted comma would silently charge $1.00
   instead of $1,602.40. Every amount from every charge path goes through here. */
/* ZZTEST fixture. Every payment on this client is a test — no real money.
   is_test is read in 9 places across platform.js and carrier.js but nothing ever
   wrote it (column default false), so once manual flagging stopped, test charges
   counted as revenue and commission and sat in agents' unfinished-audit queues. */
const TEST_CLIENT_ID = 26081;

/* Policy numbers were cut at 25 characters. The lookup is an EXACT string match,
   so a longer number was truncated, failed to match, and the payment filed at
   client level with nothing said. Five policies in the book sit exactly at 25.
   This value is only used for matching and for display on the receipt — it is
   never written back to HawkSoft as a policy number — so a generous cap is free. */
const POLICY_NUM_MAX = 60;

function parseMoney(v, dflt = 0) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : dflt;
}

/* Clover branch registry — confirmed with Saif 7/20/2026.
   Each branch = its own Clover business/merchant + one counter terminal.
   Used by the terminal-charging phase (REST Pay Display: X-Clover-Device-Id per charge).
   Ecommerce tokens currently exist for Moreno Valley (main) only.
   Excluded legacy businesses (not in service): VEX5X0YZBMVB1, 5G1JARVY3MP91. */
const CLOVER_BRANCHES = {
  1: { branch: 'Moreno Valley',        merchantId: '1K7NR5V6K1ER1', device: 'C045UT33351057', model: 'Flex 3' },
  2: { branch: 'Riverside — Van Buren', merchantId: 'YQK002AEVXRF1', device: 'C042UQ93960695', model: 'Flex'   },
  3: { branch: 'Riverside — Magnolia',  merchantId: '9SQRE50EMSDF1', device: 'C045UT32440358', model: 'Flex 3' },
  4: { branch: 'Lake Elsinore',         merchantId: 'RC02YN4Q370Z1', device: 'C046UG50362404', model: 'Flex 4' },
};

/* Clover OAuth access token from our Supabase vault, auto-refreshing */
async function getCloverToken(merchantId) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { error: 'SUPABASE env vars missing' };
  const base = url.replace(/\/$/, '');
  const hdrs = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const rr = await fetch(`${base}/rest/v1/clover_tokens?merchant_id=eq.${encodeURIComponent(merchantId)}&select=*`, { headers: hdrs });
  const rows = await rr.json().catch(() => []);
  const row = Array.isArray(rows) && rows[0];
  if (!row) return { error: `Terminal not authorized for this branch yet — run /api/clover_oauth for merchant ${merchantId}.` };
  const expSoon = row.access_expires && (new Date(row.access_expires).getTime() - Date.now() < 5 * 60 * 1000);
  if (!expSoon) return { token: row.access_token };
  // refresh
  const fr = await fetch('https://api.clover.com/oauth/v2/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.CLOVER_APP_ID, refresh_token: row.refresh_token }),
  });
  const tok = await fr.json().catch(() => null);
  if (!fr.ok || !tok || !tok.access_token) return { token: row.access_token, stale: true };
  await fetch(`${base}/rest/v1/clover_tokens?merchant_id=eq.${encodeURIComponent(merchantId)}`, {
    method: 'PATCH', headers: { ...hdrs, Prefer: 'return=minimal' },
    body: JSON.stringify({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || row.refresh_token,
      access_expires: tok.access_token_expiration ? new Date(tok.access_token_expiration * 1000).toISOString() : null,
      updated_at: new Date().toISOString(),
    }),
  });
  return { token: tok.access_token };
}

/* Payment confirmation email — Gmail SMTP from info@speedyins.com. Fail-soft. */
async function sendConfirmEmail(o) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass || !o.to) return o.to ? 'not configured' : 'no client email on file';
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    const amt = `$${Number(o.amount).toFixed(2)}`;
    const html = `<table width="560" cellpadding="0" cellspacing="0" align="center" style="background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;width:100%">
      <tr><td style="padding:22px 28px 12px;text-align:center"><img src="https://www.speedyins.com/assets/logo.png" alt="Speedy Insurance Agency" width="160" style="max-width:160px;height:auto"></td></tr>
      <tr><td style="background:#1f9d55;padding:12px 28px;text-align:center"><span style="color:#fff;font-size:18px;font-weight:bold">Payment Received — Thank You!</span></td></tr>
      <tr><td style="padding:22px 28px 6px">
        <p style="margin:0 0 14px;line-height:1.7;font-size:15px">Hi ${o.name || 'there'},</p>
        <p style="margin:0 0 16px;line-height:1.7;font-size:15px">We received your payment. Here is your confirmation:</p>
        <table width="100%" cellpadding="9" cellspacing="0" style="border:1px solid #e0e0e0;font-size:14px;margin:0 0 18px">
          <tr style="background:#0B1829"><td colspan="2" style="color:#fff;font-weight:bold">Payment Confirmation</td></tr>
          <tr><td style="color:#555;font-weight:bold;width:45%;border-bottom:1px solid #eee">Amount</td><td style="border-bottom:1px solid #eee"><b>${amt}</b></td></tr>
          <tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">For</td><td style="border-bottom:1px solid #eee">${o.purpose || 'Payment'}</td></tr>
          <tr><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Method</td><td style="border-bottom:1px solid #eee">${o.method || ''}</td></tr>
          ${o.confirmation ? `<tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Confirmation #</td><td style="border-bottom:1px solid #eee">${o.confirmation}</td></tr>` : ''}
          <tr><td style="color:#555;font-weight:bold">Date</td><td>${o.stamp || ''} PT</td></tr>
        </table>
        <p style="margin:0 0 14px;line-height:1.6;font-size:12px;color:#888;font-style:italic">A record of this payment has been filed with your Speedy Insurance account. If you did not make this payment, call us immediately at (951) 472-0927.</p>
      </td></tr>
      <tr><td style="padding:0 28px 24px"><table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #D42B2B"><tr><td style="padding-top:12px;font-size:13px;line-height:1.8;color:#444"><strong>Speedy Insurance Agency</strong><br>(951) 472-0927 · speedyins.com</td></tr></table></td></tr></table>`;
    await t.sendMail({
      from: `"Speedy Insurance Agency" <${user}>`, to: o.to,
      subject: `Payment received — ${amt} — Speedy Insurance Agency`,
      html,
      text: `Payment received: ${amt} for ${o.purpose || 'Payment'}. ${o.confirmation ? 'Confirmation ' + o.confirmation + '. ' : ''}Speedy Insurance Agency, (951) 472-0927.`,
    });
    return `sent to ${o.to}`;
  } catch (e) { return `failed: ${String(e).slice(0, 80)}`; }
}
const emailFrom = (body) => {
  try {
    const m = JSON.stringify(body).match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
    return (m && m[0]) || '';
  } catch { return ''; }
};

/* Decline alert to the responsible agent — so failed payments get a follow-up call */
async function sendDeclineAlert(o) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass || !o.to) return 'not sent';
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
    const amt = `$${Number(o.amount).toFixed(2)}`;
    await t.sendMail({
      from: `"Speedy Payment Bridge" <${user}>`, to: o.to,
      subject: `⚠ Payment DECLINED — ${amt} — client #${o.clientId}`,
      html: `<table width="560" cellpadding="0" cellspacing="0" align="center" style="background:#fff;font-family:Arial,sans-serif;color:#222;max-width:560px;width:100%">
        <tr><td style="background:#D42B2B;padding:12px 24px;text-align:center;color:#fff;font-size:17px;font-weight:bold">Payment Declined — Follow Up Needed</td></tr>
        <tr><td style="padding:20px 24px">
          <table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #e0e0e0;font-size:14px">
            <tr><td style="color:#555;font-weight:bold;width:40%;border-bottom:1px solid #eee">Amount</td><td style="border-bottom:1px solid #eee"><b>${amt}</b></td></tr>
            <tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Client</td><td style="border-bottom:1px solid #eee">${o.clientName || ''} · #${o.clientId}</td></tr>
            <tr><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">For</td><td style="border-bottom:1px solid #eee">${o.purpose || ''}</td></tr>
            <tr style="background:#f7f7f7"><td style="color:#555;font-weight:bold;border-bottom:1px solid #eee">Channel</td><td style="border-bottom:1px solid #eee">${o.channel || ''}</td></tr>
            <tr><td style="color:#555;font-weight:bold">Decline reason</td><td><b style="color:#D42B2B">${o.reason || 'not provided by processor'}</b></td></tr>
          </table>
          <p style="font-size:13px;color:#555;line-height:1.6;margin:14px 0 0">The card was NOT charged. Consider calling the client to retry with another card or send a new payment link.</p>
        </td></tr></table>`,
      text: `Payment DECLINED: ${amt}, client #${o.clientId} (${o.clientName || ''}), ${o.purpose || ''}. Reason: ${o.reason || 'not provided'}. Channel: ${o.channel || ''}. Card was not charged.`,
    });
    return `alerted ${o.to}`;
  } catch (e) { return `alert failed: ${String(e).slice(0, 60)}`; }
}

/* Signed pay-link tokens (HMAC-SHA256, keyed on ADMIN_API_KEY) */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (obj, key) => { const pl = b64u(JSON.stringify(obj)); return pl + '.' + b64u(createHmac('sha256', key).update(pl).digest()).slice(0, 22); };
function primaryPerson(people){
  const arr = Array.isArray(people) ? people : [];
  // 1) the named insured is flagged mainContactType 'First'
  let p = arr.find(x => String((x && (x.mainContactType || x.MainContactType)) || '').toLowerCase() === 'first');
  // 2) else first entry that actually has a name (skips blank/excluded-only rows)
  if (!p) p = arr.find(x => x && (x.businessName || x.firstName || x.lastName));
  // 3) else fall back to first
  return p || arr[0] || {};
}

const clientNameFrom = (b) => {
  let name = '';
  const people = (b && (b.people || b.People)) || [];
  if (people.length) {
    const pp = primaryPerson(people);
    name = [pp.businessName, [pp.firstName, pp.lastName].filter(Boolean).join(' ')].filter(Boolean)[0] || '';
  }
  if (!name) name = (b && (b.businessName || b.name)) || '';
  return name;
};
const readToken = (t, key) => {
  try {
    const [pl, sig] = String(t || '').split('.');
    if (!pl || !sig) return null;
    const full = b64u(createHmac('sha256', key).update(pl).digest());
    if (sig !== full && sig !== full.slice(0, 22)) return null;
    const o = JSON.parse(Buffer.from(pl.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!o.exp || Date.now() > o.exp) return null;
    return o;
  } catch { return null; }
};

/* Pick the invoice(s) a payment should apply to (requires Accounting/Invoices scope, enabled 7/20/2026).
   Conservative: exact amount on the policy -> exact amount anywhere -> oldest open on the policy covering it -> none. */
function pickInvoices(clientBody, total, policyGuid) {
  const raw = (clientBody && (clientBody.invoices || clientBody.Invoices)) || [];
  const cents = x => Math.round(Number(x) * 100);
  const inv = raw.map(i => ({
    id: i.id || i.invoiceId || i.guid || i.Id || null,
    bal: Number(i.balance ?? i.balanceDue ?? i.amountDue ?? i.due ?? i.remaining ?? i.amount ?? NaN),
    pol: i.policyId || i.policyGuid || i.PolicyId || null,
    dueDate: i.dueDate || i.DueDate || '',
    num: i.invoiceNumber || i.number || i.InvoiceNumber || '',
  })).filter(i => i.id && isFinite(i.bal) && i.bal > 0);
  let hit = policyGuid ? inv.find(i => i.pol === policyGuid && cents(i.bal) === cents(total)) : null;
  let how = hit ? 'applied — exact match on policy' : '';
  if (!hit) { hit = inv.find(i => cents(i.bal) === cents(total)) || null; if (hit) how = 'applied — exact amount match'; }
  if (!hit && policyGuid) {
    const cands = inv.filter(i => i.pol === policyGuid && i.bal >= total)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    hit = cands[0] || null; if (hit) how = 'applied — oldest open invoice on policy';
  }
  if (!hit) return { invoices: null, how: raw.length ? 'no matching open invoice — left unapplied' : 'no invoices on file' };
  return { invoices: [{ invoiceId: hit.id, amount: total }], how: how + (hit.num ? ` (${hit.num})` : '') };
}

/* ---------- Google Sign-In (charge page) ---------- */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const STAFF = {
  'sammy@speedyins.com':     ['Samuel Rodriguez', 'Moreno Valley'],
  'yolanda@speedyins.com':   ['Yolanda Hernandez', 'Lake Elsinore'],
  'jorge@speedyins.com':     ['Jorge Ramos', 'Moreno Valley'],
  'lfigueroa@speedyins.com': ['Laura Figueroa', 'Moreno Valley'],
  'chris@speedyins.com':     ['Christian Aguilar', 'Colton'],
  'yasmin@speedyins.com':    ['Yasmin Alfaro', 'Riverside Van Buren'],
  'fernando@speedyins.com':  ['Fernando Salgado', 'Riverside Van Buren'],
  'jesus@speedyins.com':     ['Jesus Velarde', 'Riverside Van Buren'],
  'alejandra@speedyins.com': ['Alejandra Salas', 'Riverside Magnolia'],
  'esmeralda@speedyins.com': ['Esmeralda Ayala Hernandez', 'Riverside Magnolia'],
  'irene@speedyins.com':     ['Irene Ayala Hernandez', 'Riverside Magnolia'],
  'melisa@speedyins.com':    ['Melisa Hernandez', 'Moreno Valley'],
  'tony@speedyins.com':      ['Tony Dabouqi', 'All branches'],
  'lana@speedyins.com':      ['Lana D.', 'All branches'],
};
/* ---------- Independent audit log (Vercel Blob) — survives HawkSoft outages ---------- */
/* Speedy's OWN payment ledger (Supabase) — dual-write on every bridge event.
   Foundation for reporting + eventual AMS independence. Fail-soft: never blocks a charge. */
/* The audit_status column defaults to 'client_paid', which is only correct for a real
   payment. Declines, pay-link creation and client creation were inheriting it and
   landing in the agents' audit queue demanding proof for money that never arrived.
   Status is now derived from the event, never left to the default. */
function auditStatusFor(kind) {
  const k = String(kind || '');
  if (/declin|fail|void|refund/i.test(k)) return 'declined';
  if (k === 'paylink_create') return 'link_sent';
  if (k === 'charge_create_client') return 'not_a_payment';
  // charge_captured is the safety-net row written the instant Clover confirms — real
  // money, receipt still pending. It must NEVER be filtered out of the audit queue.
  if (/^(charge_live|charge_cash|charge_card|terminal_charge|paylink_charge|charge_captured)$/.test(k)) return 'client_paid';
  return 'not_a_payment';   // anything that isn't a known money event stays out of the queue
}

async function ledger(event) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  try {
    const kind = event.action || 'event';
    const row = {
      kind,
      audit_status: auditStatusFor(kind),
      // who earns this: chosen by the agent, defaulting to whoever is charging
      commission_to: normaliseAgentEmail(event.commissionTo) || normaliseAgentEmail(event.who) || null,
      // Partial payments: total_owed is what the client owes in full. Blank means paid
      // in full, so it simply equals the amount collected. balance_of points a follow-up
      // payment at the original charge it pays down.
      total_owed: (event.totalOwed != null && parseMoney(event.totalOwed) > 0)
        ? parseMoney(event.totalOwed) : null,
      balance_of: event.balanceOf || null,
      // snapshot of the client's producer at the time of charge — never rewritten later
      producer_code: event.producerCode ? String(event.producerCode).slice(0, 8) : null,
      client_id: Number.isFinite(parseInt(event.clientId, 10)) ? parseInt(event.clientId, 10) : null,
      amount: (typeof event.amount === 'number') ? event.amount : null,
      purpose: event.purpose ? String(event.purpose).slice(0, 120) : null,
      agent: event.who ? String(event.who).slice(0, 120) : null,
      txn_id: event.txnId || null,
      auth_code: event.authCode ? String(event.authCode) : null,
      ref: event.ref || null,
      invoice_status: event.invoiceApply || (event.hawksoft && event.hawksoft.invoiceApply) || null,
      // Set here, not by the caller — every path writes through ledger(), so the
      // flag cannot drift no matter which page or action created the row.
      is_test: parseInt(event.clientId, 10) === TEST_CLIENT_ID,
      extra: event,
    };
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/bridge_ledger`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (r.status !== 201) return false;
    try {
      const rows = await r.json();
      const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
      return id ? { ok: true, id } : true;
    } catch { return true; }
  } catch { return false; }
}

/* Store a generated receipt PDF in OUR attachments vault so it's visible in the Audit tab.
   Fail-soft: never blocks a charge. kind = 'client_receipt' (the branded PDF the client gets). */
async function storeReceiptVault({ clientId, pdfBuf, filename, amount, txnId, who, policyGuid }) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key || !pdfBuf) return false;
  try {
    const b64 = pdfBuf.toString('base64');
    const hashBuf = await crypto.subtle.digest('SHA-256', pdfBuf);
    const sha = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const row = {
      client_no: Number.isFinite(parseInt(clientId, 10)) ? parseInt(clientId, 10) : null,
      kind: 'client_receipt', doc_type: 'client_receipt',
      filename: (filename || 'receipt') + '.pdf',
      file_b64: b64, sha256: sha, mime: 'application/pdf', bytes: pdfBuf.length,
      amount: (typeof amount === 'number') ? amount : null,
      uploaded_by: who ? String(who).slice(0, 120) : 'charge_page',
    };
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/attachments`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify([row]),
    });
    if (r.status !== 201) return false;
    try {
      const rows = await r.json();
      const id = Array.isArray(rows) && rows[0] ? rows[0].id : null;
      return id ? { ok: true, id } : true;
    } catch { return true; }
  } catch { return false; }
}

/* Link a stored receipt to its ledger row. The receipt PDF is written before the
   ledger row exists on some paths, so payment_id is stamped afterwards — without it
   every receipt on a client appears against every payment in the document viewer. */
async function linkReceiptToPayment(attachmentId, paymentId) {
  if (!attachmentId || !paymentId) return false;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/attachments?id=eq.${attachmentId}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ payment_id: paymentId }),
    });
    return r.status === 204 || r.status === 200;
  } catch { return false; }
}

async function audit(event) {
  const sb = await ledger(event); // Speedy ledger first — our system of record
  const tok = process.env.BLOB_READ_WRITE_TOKEN;
  if (!tok) return sb;
  try {
    const ts = new Date().toISOString();
    const path = `audit/${ts.slice(0, 10)}/${ts.replace(/[:.]/g, '-')}_${event.action || 'event'}.json`;
    const r = await fetch(`https://blob.vercel-storage.com/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tok}`,
        'x-api-version': '7',
        'content-type': 'application/json',
        'x-add-random-suffix': '0',
      },
      body: JSON.stringify({ ts, ...event }),
    });
    return (sb && sb.id) ? sb : (r.status === 200);
  } catch { return sb; }
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

async function verifyGoogleToken(idToken) {
  if (GOOGLE_CLIENT_ID === 'NOT_CONFIGURED') return null;
  const c = await googleClaims(idToken);
  if (!c) return null;
  if (!c.email.endsWith('@speedyins.com')) return null;
  return c.email;
}
const BASE = 'https://integration.hawksoft.app';

// Map human LOB names to HawkSoft LOB codes (v4 spec enumeration).
const HS_LOB_CODES = new Set(['ACCT','AGENT','AGLIA','AGPP','AGPR','ANUTY','APKGE','ARCH','AUTOB','AUTOP','BANDM','BLDRK','BMSBP','BOAT','BOP','BOPGL','BOPPR','CFIRE','CGL','COMAR','CONTR','CPKGE','CPL','CRIM','CROP','CUMBR','CYBER','CYCLE','DFIRE','DO','EDP','ELIAB','EO','EPLI','EQ','EQLIA','FIDUC','FINAR','FLOOD','FRBD','GARAG','GLASS','HEALTH','HOME','INMRC','INMRP','INTER','KIDRA','LAW','LIFE','LL','LMORT','MEDIA','MHOME','MMAL','MOPRO','MPL','MTRCR','MTRTK','OCMRC','OPCAR','OTHER','PHYS','PL','PLMSC','PPKGE','PROP','PUMBR','RECV','RRPRL','SCHPR','SFRNC','SIGNS','SMP','SURE','TRANS','TRKRS','ULIFE','VALP','WIND','WORK','WORKV','YACHT','RTRMT','SUPPL','GPMED','GPDEN','GPVIS','GPLIF','GPACC','GPDIS','GPCRI','GPOTH']);
function mapLob(input) {
  const raw = String(input || '').trim();
  const up = raw.toUpperCase();
  if (HS_LOB_CODES.has(up)) return up;
  const s = up.replace(/[^A-Z ]/g, ' ');
  if (/PERSONAL AUTO|PRIVATE PASSENGER|(^| )AUTO( |$)|PPA/.test(s)) return 'AUTOP';
  if (/COMMERCIAL AUTO|BUSINESS AUTO/.test(s)) return 'AUTOB';
  if (/HOMEOWNER|(^| )HOME( |$)|HO\d/.test(s)) return 'HOME';
  if (/RENTER/.test(s)) return 'HOME';
  if (/MOBILE HOME|MANUFACTURED/.test(s)) return 'MHOME';
  if (/DWELLING|FIRE POLICY|LANDLORD/.test(s)) return 'DFIRE';
  if (/MOTORCYCLE|MOTOR CYCLE/.test(s)) return 'CYCLE';
  if (/(^| )RV( |$)|RECREATIONAL/.test(s)) return 'RECV';
  if (/BOAT|WATERCRAFT/.test(s)) return 'BOAT';
  if (/PERSONAL UMBRELLA/.test(s)) return 'PUMBR';
  if (/COMMERCIAL UMBRELLA/.test(s)) return 'CUMBR';
  if (/UMBRELLA/.test(s)) return 'PUMBR';
  if (/FLOOD/.test(s)) return 'FLOOD';
  if (/EARTHQUAKE/.test(s)) return 'EQ';
  if (/GENERAL LIABILITY|(^| )GL( |$)/.test(s)) return 'CGL';
  if (/BUSINESS OWNER|(^| )BOP( |$)/.test(s)) return 'BOP';
  if (/WORKERS? COMP/.test(s)) return 'WORK';
  if (/COMMERCIAL PROPERTY/.test(s)) return 'PROP';
  if (/COMMERCIAL PACKAGE/.test(s)) return 'CPKGE';
  if (/LIFE/.test(s)) return 'LIFE';
  if (/HEALTH|MEDICAL/.test(s)) return 'HEALTH';
  return 'OTHER';
}

/* ================= SINGLE SOURCE: branded receipt PDF =================
   Every charge path — card (charge page + portal), cash/Zelle/Other,
   terminal, and pay link — builds and files its receipt through these two
   functions. Change the receipt design ONCE here and every path gets it.
   Params that differ per method are passed in; everything else is shared. */
async function buildReceiptPdf(o) {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const W = 306, H = 590;
  const page = doc.addPage([W, H]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const boldObl = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
  const obl = await doc.embedFont(StandardFonts.HelveticaOblique);
  const RED = rgb(0.83, 0.17, 0.17), NAVY = rgb(0.10, 0.14, 0.34), GRAY = rgb(0.4, 0.4, 0.4),
        LIGHT = rgb(0.6, 0.6, 0.6), GREEN = rgb(0.13, 0.63, 0.35), BLACK = rgb(0, 0, 0),
        LINE = rgb(0.8, 0.8, 0.8);
  const ctr = (t, y, f, sz, c) => page.drawText(t, { x: (W - f.widthOfTextAtSize(t, sz)) / 2, y, font: f, size: sz, color: c });
  const dash = y => page.drawLine({ start: { x: 25, y }, end: { x: W - 25, y }, thickness: 1, color: LINE, dashArray: [2, 2] });
  const solid = y => page.drawLine({ start: { x: 25, y }, end: { x: W - 25, y }, thickness: 1, color: LINE });
  let y = H - 32;
  ctr('SPEEDY', y, boldObl, 15, NAVY); y -= 19;
  ctr('INSURANCE AGENCY', y, boldObl, 17, RED); y -= 15;
  ctr(o.branchName || 'Speedy Insurance Agency', y, helv, 8, GRAY); y -= 11;
  ctr('(951) 472-0927  \u00b7  speedyins.com', y, helv, 8, GRAY); y -= 16;
  dash(y); y -= 20;
  ctr('PAYMENT RECEIPT', y, bold, 11, NAVY); y -= 26;
  ctr(`$${o.total.toFixed(2)}`, y, bold, 26, BLACK); y -= 15;
  ctr(o.headline, y, bold, 9, GREEN); y -= 22;
  /* Values are right-aligned with no wrapping, so an over-long one would run off
     the 306pt page or collide with its label. Trim to the space actually left after
     the label rather than to a character count — a character cap cannot know the
     font width. Nothing the caller passes can break the receipt. */
  const row = (label, value, isBold) => {
    page.drawText(label, { x: 29, y, font: helv, size: 8.5, color: GRAY });
    const f = isBold ? bold : helv;
    const avail = W - 29 - 29 - helv.widthOfTextAtSize(label, 8.5) - 10;
    let v = String(value);
    if (f.widthOfTextAtSize(v, 8.5) > avail) {
      while (v.length > 1 && f.widthOfTextAtSize(v + '\u2026', 8.5) > avail) v = v.slice(0, -1);
      v += '\u2026';
    }
    const vw = f.widthOfTextAtSize(v, 8.5);
    page.drawText(v, { x: W - 29 - vw, y, font: f, size: 8.5, color: BLACK });
    y -= 12;
  };
  row('Date / Time', o.stamp + ' PT');
  row('Client', o.clientName || ('Client #' + o.clientId), true);
  row('Client #', String(o.clientId));
  row('Payment for', String(o.purpose).slice(0, 38));
  // Carrier alongside the number: "RIB01013493 — RELIANT" means something to a
  // client; a bare string does not, and a wrong bare string looks like our error.
  if (o.policyNumber) row('Policy #', o.policyNumber + (o.policyCarrier ? '  —  ' + o.policyCarrier : ''), true);
  y -= 4; dash(y); y -= 14;
  for (const r of (o.detailRows || [])) row(r[0], r[1], r[2]);
  y -= 4; solid(y); y -= 14;
  page.drawText(o.recordTitle, { x: 29, y, font: bold, size: 8.5, color: NAVY }); y -= 13;
  for (const r of (o.recordRows || [])) row(r[0], r[1], r[2]);
  y -= 4; solid(y); y -= 16;
  for (const t of (o.footerLines || [])) { if (t) ctr(t, y, obl, 7, LIGHT); y -= 9; }
  y -= 6;
  ctr('Thank you for choosing Speedy Insurance!', y, bold, 8, NAVY);
  return Buffer.from(await doc.save());
}

/* Attach the receipt PDF to the HawkSoft client record AND store it in our vault.
   Returns { fname, attachment, vault } — fail-soft, same shape for every path. */
async function fileReceiptPdf(o) {
  const { gzipSync } = await import('node:zlib');
  const b64h = str => Buffer.from(str, 'utf8').toString('base64');
  const fname = `${o.filePrefix}_${o.now.toISOString().slice(0, 10)}_${String(o.total.toFixed(2)).replace('.', '-')}usd`;
  const r2 = await o.hs(`/vendor/agency/${AGENCY_ID}/client/${o.clientId}/attachment?version=4.0`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      RefId: crypto.randomUUID(), TS: o.now.toISOString(),
      Desc: b64h(String(o.desc).slice(0, 41)),
      LogNote: b64h(`Receipt PDF "${fname}.pdf" filed by the Speedy payment bridge. ${o.logNoteTail || ''}`.trim()),
      FileName: b64h(fname), FileExt: 'pdf', Channel: '32', // Online From 3rd Party
      ...(o.policyGuid ? { PolicyId: o.policyGuid } : {}),
    },
    body: gzipSync(o.pdfBuf),
  });
  const attachment = { ok: r2.status === 200 || r2.status === 202, status: r2.status, ...(r2.status >= 400 ? { error: r2.body } : {}) };
  const vault = await storeReceiptVault({ clientId: o.clientId, pdfBuf: o.pdfBuf, filename: fname,
    amount: o.total, txnId: o.txnId || null, who: o.who, policyGuid: o.policyGuid });
  return { fname, attachment, vault };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const ID = process.env.HAWKSOFT_CLIENT_ID;
  const SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing HAWKSOFT_CLIENT_ID or HAWKSOFT_SECRET env var' });
  }
  const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');

  const hs = async (path, opts = {}) => {
    const r = await fetch(BASE + path, {
      ...opts,
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: r.status, body };
  };

  /* ================= POST: Test Lab (server-side key required) ================= */
  if (req.method === 'POST') {
    const KEY = process.env.ADMIN_API_KEY;
    if (!KEY) return res.status(500).json({ ok: false, error: 'ADMIN_API_KEY env var not set in Vercel' });
    const isAdmin = (req.headers['x-admin-key'] || '') === KEY;
    const PUBLIC_PAY = ['paylink_info', 'paylink_name', 'paylink_charge']; // authenticated by signed token, used by pay.html
    let userEmail = null;
    if (!isAdmin && !PUBLIC_PAY.includes((req.body || {}).action)) {
      userEmail = await verifyGoogleToken(req.headers['x-user-token']);
      if (!userEmail) {
        return res.status(401).json({ ok: false, error: GOOGLE_CLIENT_ID === 'NOT_CONFIGURED'
          ? 'Sign-in not configured yet (GOOGLE_CLIENT_ID env var missing) — use admin key.'
          : 'Sign in with your @speedyins.com Google account, or use the admin key.' });
      }
    }

    const { action } = req.body || {};

    // Google-authenticated users may only use charge-page actions
    if (!isAdmin && !userEmail && !PUBLIC_PAY.includes(action)) {
      return res.status(401).json({ ok: false, error: 'Sign in required.' });
    }
    if (!isAdmin && userEmail && !['charge_lookup', 'charge_log', 'search_policy', 'charge_create_client', 'charge_full_test', 'probe_channels', 'ecomm_config', 'charge_live', 'charge_cash', 'paylink_create', 'probe_invoices', 'terminal_config', 'terminal_charge'].includes(action)) {
      return res.status(403).json({ ok: false, error: 'This action requires the admin key.' });
    }

    /* ---------- Charge page: real-name lookup (minimal fields, no policy/PII dump) ---------- */
    if (action === 'charge_lookup') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=Details,People,Contacts,Policies,Invoices`, {});
      if (r.status !== 200) return res.status(200).json({ ok: false, httpStatus: r.status, error: 'Client not found' });
      const b = r.body || {};
      // Defensive extraction — v4 shapes vary
      let name = '';
      const people = b.people || b.People || [];
      if (people.length) {
        const p = primaryPerson(people);
        name = [p.businessName, [p.firstName, p.lastName].filter(Boolean).join(' ')].filter(Boolean)[0] || '';
      }
      if (!name) name = b.businessName || b.name || '';
      const raw = JSON.stringify(b);
      const phones = [...new Set((raw.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []))].slice(0, 3);
      const emails = [...new Set((raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []))].slice(0, 2);
      const officeId = b.officeId || (b.details && b.details.officeId) || b.OfficeId || null;
      const status = b.status || (b.details && b.details.status) || '';
      // Open invoices (requires Invoices scope) — lets the page prefill amount for guaranteed auto-apply
      const polNumById = {};
      for (const pl of (b.policies || b.Policies || [])) {
        const gid = pl.id || pl.policyId || pl.guid || pl.Id;
        if (gid) polNumById[gid] = pl.policyNumber || pl.PolicyNumber || '';
      }
      const openInvoices = ((b.invoices || b.Invoices || []).map(i => ({
        id: i.id || i.invoiceId || i.guid || i.Id || null,
        num: i.invoiceNumber || i.number || i.InvoiceNumber || '',
        bal: Number(i.balance ?? i.balanceDue ?? i.amountDue ?? i.due ?? i.remaining ?? i.amount ?? NaN),
        dueDate: String(i.dueDate || i.DueDate || '').slice(0, 10),
        policyNumber: polNumById[i.policyId || i.policyGuid || i.PolicyId] || '',
      })).filter(i => i.id && isFinite(i.bal) && i.bal > 0)).slice(0, 6);
      // Build the charge-name dropdown from POLICY DRIVERS — the real source of insured/excluded status.
      // relationship:'Insured' + personalInfo.status:'Principal' = named insured; status:'Excluded' = excluded driver.
      const allPolicies = b.policies || b.Policies || [];
      const driverMap = new Map(); // dedupe by name, prefer the strongest role
      const roleRank = { 'named insured': 0, 'active': 1, 'driver': 1, 'excluded': 2 };
      for (const pol of allPolicies) {
        for (const dr of (pol.drivers || pol.Drivers || [])) {
          const nm = [dr.firstName, dr.middleName, dr.lastName].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
          if (!nm) continue;
          const rel = String(dr.relationship || '').toLowerCase();
          const st = String((dr.personalInfo && dr.personalInfo.status) || '').toLowerCase();
          let role = 'active';
          if (rel === 'insured' || st === 'principal') role = 'named insured';
          else if (st === 'excluded') role = 'excluded';
          const prev = driverMap.get(nm.toUpperCase());
          if (!prev || roleRank[role] < roleRank[prev.role]) driverMap.set(nm.toUpperCase(), { name: nm, role });
        }
      }
      let peopleList = [...driverMap.values()].sort((a, b) => (roleRank[a.role] - roleRank[b.role]));
      // Fallback to client people if no drivers on any policy
      if (!peopleList.length) {
        peopleList = (people || []).map(x => ({
          name: [x.businessName, [x.firstName, x.lastName].filter(Boolean).join(' ')].filter(Boolean)[0] || '',
          role: 'active',
        })).filter(p => p.name);
      }
      // The named insured drives the displayed client name (overrides people[0] if found)
      const insured = peopleList.find(p => p.role === 'named insured');
      if (insured) name = insured.name;
      /* Policy list for the charge page's picker.
         This data was already fetched and used for polNumById - it was simply not
         returned. Without it charge.html only knew a policy when HawkLink happened
         to supply one, which depends on which HawkSoft tab the agent launched from,
         so payments filed at client level (Pol 0) at random. */
      const todayISO = new Date().toISOString().slice(0, 10);
      const policyList = allPolicies.map(pl => {
        const exp = String(pl.expirationDate || pl.ExpirationDate || '').slice(0, 10);
        return {
          number: String(pl.policyNumber || pl.PolicyNumber || '').trim(),
          carrier: String(pl.carrier || pl.Carrier || pl.company || '').trim().slice(0, 40),
          expired: !!(exp && exp < todayISO),
        };
      }).filter(p => p.number);

      return res.status(200).json({ ok: true, result: {
        clientNumber: b.clientNumber || clientId, name: name || '(no name on file)',
        phones, emails, officeId, status, openInvoices, people: peopleList,
        policies: policyList,
      }});
    }

    /* ---------- Correct a payment posted to the wrong client ----------
       HawkSoft has no delete, so nothing is removed: a correction note is written to
       BOTH records. The wrong client keeps an honest "posted in error" trail and the
       right client gets the payment with its history. The Clover transaction is never
       touched — the money is correct, only the filing was wrong. */
    if (action === 'move_client_notes') {
      const b = req.body || {};
      const fromId = parseInt(b.fromClient, 10);
      const toId = parseInt(b.toClient, 10);
      const amount = parseMoney(b.amount);
      const who = String(b.who || 'Speedy payment bridge').slice(0, 80);
      const why = String(b.reason || '').slice(0, 120);
      const ref = String(b.txnId || b.ref || '').slice(0, 40);
      if (!fromId || !toId) return res.status(400).json({ ok: false, error: 'fromClient and toClient required' });

      const stampNow = new Date().toISOString();
      const note = async (clientId, text) => {
        const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
          method: 'POST', body: JSON.stringify({
            refId: crypto.randomUUID(), ts: stampNow, channel: 32,
            note: text,
          }) });
        return { ok: r.status === 200 || r.status === 202, status: r.status };
      };

      const out = {};
      out.fromNote = await note(fromId,
        `CORRECTION — the $${amount.toFixed(2)} payment logged here on this record was posted to the wrong client in error `
        + `and has been moved to client #${toId}. No money was refunded or re-charged; the card transaction is unchanged`
        + `${ref ? ' (Clover ' + ref + ')' : ''}. Corrected by ${who}${why ? ' — ' + why : ''}.`);
      out.toNote = await note(toId,
        `CORRECTION — a $${amount.toFixed(2)} payment originally logged under client #${fromId} in error belongs to this client `
        + `and has been moved here${ref ? ' (Clover ' + ref + ')' : ''}. Corrected by ${who}${why ? ' — ' + why : ''}.`);
      return res.status(200).json({ ok: out.fromNote.ok && out.toNote.ok, results: out });
    }

    /* ---------- Charge page: create a new client (charge-first workflow) ---------- */
    if (action === 'charge_create_client') {
      const b = req.body || {};
      const first = String(b.firstName || '').trim().slice(0, 14);
      const last = String(b.lastName || '').trim().slice(0, 24);
      const phone = String(b.phone || '').replace(/\D/g, '');
      const officeId = parseInt(b.officeId, 10);
      if (!first || !last) return res.status(400).json({ ok: false, error: 'First and last name required' });
      if (phone.length !== 10) return res.status(400).json({ ok: false, error: 'Phone must be 10 digits' });
      if (![1, 2, 3].includes(officeId)) return res.status(400).json({ ok: false, error: 'Pick a branch' });
      const who = userEmail
        ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail)
        : 'admin key';
      const payload = {
        officeId,
        status: 'Active',
        source: 'Charge Page',
        people: [{
          firstName: first, lastName: last, mainContactType: 'First',
          contacts: [{ type: 'CellPhone', value: `(${phone.slice(0,3)})${phone.slice(3,6)}-${phone.slice(6)}` }],
        }],
        log: {
          channel: 31,
          note: `Client created from the Charge page by ${who} (charge-first workflow). Complete details in CMS.`,
          ts: new Date().toISOString(),
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      let clientNumber = null;
      if (r.body && typeof r.body === 'object') {
        clientNumber = r.body.clientNumber || r.body.clientId || r.body.id || null;
      }
      const auditSaved = await audit({ action: 'charge_create_client', who, officeId, clientNumber, httpStatus: r.status });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, clientNumber, result: r.body, auditSaved });
    }

    /* ---------- Channel probe — labeled logs on ZZTEST to map channel numbers to UI wording ---------- */
    if (action === 'probe_channels') {
      const results = [];
      for (const ch of [25, 26, 27, 28, 30, 32, 33, 34, 35, 36]) {
        const r = await hs(`/vendor/agency/${AGENCY_ID}/client/26081/log?version=4.0`, {
          method: 'POST', body: JSON.stringify({
            refId: crypto.randomUUID(), ts: new Date().toISOString(), channel: ch,
            note: `CHANNEL PROBE — this is channel ${ch}. Look at the Online/Walkin + From columns for this row.`,
          }) });
        results.push({ channel: ch, status: r.status });
      }
      return res.status(200).json({ ok: true, results,
        hint: 'Open ZZTEST Log tab — each probe row shows how its channel number renders. Find the one that says From > Other.' });
    }

    /* ---------- Charge page: FULL trail test — receipt + PDF attachment + log, ZZTEST only ---------- */
    /* ---------- Charge page: ecommerce config — public key only, never the private ---------- */
    if (action === 'ecomm_config') {
      return res.status(200).json({ ok: true,
        publicKeySet: !!process.env.CLOVER_ECOMM_PUBLIC,
        privateKeySet: !!process.env.CLOVER_ECOMM_PRIVATE,
        pk: process.env.CLOVER_ECOMM_PUBLIC || null,
        merchantId: '1K7NR5V6K1ER1' });
    }

    /* ---------- Charge page: LIVE card charge via Clover ecommerce (phase 1: ZZTEST only, $1 cap) ---------- */
    if (action === 'charge_live' || action === 'paylink_charge') {
      const PRIV = process.env.CLOVER_ECOMM_PRIVATE;
      if (!PRIV) return res.status(500).json({ ok: false, error: 'CLOVER_ECOMM_PRIVATE env var not set in Vercel' });
      const b = req.body || {};
      let clientId, total, purpose, policyNumber, clientName, who, taskEmail;
      if (action === 'paylink_charge') {
        const tok = readToken(b.t, KEY);
        if (!tok) return res.status(400).json({ ok: false, error: 'This payment link is invalid or has expired. Please ask your agent for a new one.' });
        clientId = parseInt(tok.c, 10);
        total = Math.round(parseMoney(tok.a) * 100) / 100;
        purpose = String(tok.p || 'Payment').slice(0, 80);
        policyNumber = String(tok.pol || '').trim().slice(0, POLICY_NUM_MAX);
        clientName = String(tok.n || '').slice(0, 40);
        const byFull = String(tok.by || 'agent').includes('@') ? String(tok.by) : String(tok.by || 'agent') + '@speedyins.com';
        who = `Client — secure link (sent by ${byFull.slice(0, 40)})`;
        taskEmail = byFull;
      } else {
        clientId = parseInt(b.clientId, 10);
        total = Math.round(parseMoney(b.amount) * 100) / 100;
        purpose = String(b.purpose || 'Down payment').slice(0, 80);
        policyNumber = String(b.policyNumber || '').trim().slice(0, POLICY_NUM_MAX);
        clientName = String(b.clientName || '').slice(0, 40);
        who = userEmail
          ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail)
          : 'admin key';
        taskEmail = userEmail || 'info@speedyins.com';
      }
      if (!clientId || clientId < 1) {
        return res.status(400).json({ ok: false, error: 'Verify and confirm the client in HawkSoft first.' });
      }
      if (!total || total < 0.5) {
        return res.status(400).json({ ok: false, error: 'Amount must be at least $0.50.' });
      }
      const office = String(b.office || '').slice(0, 40) || null; // branch the agent selected in the portal
      const recover = b.skipCharge === true; // recovery: card already charged on Clover, just record it
      const source = String(b.source || '');
      if (!recover && (!source || source.length < 8)) {
        return res.status(400).json({ ok: false, error: 'Missing payment token from the secure payment fields.' });
      }
      const now = new Date();
      const stamp = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

      let cbody = null, paid = true, cr = null;
      if (!recover) {
        // 1) Charge the card — Clover ecommerce API
        cr = await fetch('https://scl.clover.com/v1/charges', {
          method: 'POST',
          headers: { Authorization: `Bearer ${PRIV}`, 'Content-Type': 'application/json',
            'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ amount: Math.round(total * 100), currency: 'usd', source,
            description: `Speedy Insurance — ${purpose} — client ${clientId}` }),
        });
        const ctext = await cr.text();
        try { cbody = ctext ? JSON.parse(ctext) : null; } catch { cbody = ctext; }
        paid = cr.status === 200 && cbody && (cbody.paid === true || cbody.status === 'succeeded');
        if (!paid) {
          const err = (cbody && cbody.error) || {};
          const msg = err.message || err.code || (cbody && cbody.message)
            || (cbody && cbody.failure_message) || (cbody && cbody.status) || `Clover returned HTTP ${cr.status}`;
          const alertTo = (action === 'paylink_charge') ? (typeof taskEmail === 'string' ? taskEmail : null) : userEmail;
          const alerted = await sendDeclineAlert({ to: alertTo || 'info@speedyins.com', amount: total, clientId, clientName, purpose,
            reason: msg, channel: action === 'paylink_charge' ? 'Pay link (client self-pay)' : 'Charge page — typed card' });
          await audit({ action: action + '_declined', who, clientId, amount: total, purpose, reason: msg, alerted, cloverStatus: cr.status, clover: cbody });
          return res.status(402).json({ ok: false, error: `Charge failed: ${msg}` });
        }
      }
      const txnId = recover ? String(b.txnId || 'UNKNOWN') : String(cbody.id || 'UNKNOWN');
      const authCode = recover ? (b.authCode || null) : (cbody.auth_code || cbody.authCode || null);
      const refNum = recover ? (b.refNum || null) : (cbody.ref_num || cbody.refNum || null);
      const brand = recover ? String(b.brand || 'VISA').toUpperCase() : String((cbody.source && cbody.source.brand) || 'CARD').toUpperCase();
      const last4 = recover ? String(b.last4 || '????') : String((cbody.source && cbody.source.last4) || '????');
      const out = { charge: { ok: true, id: txnId, amount: total, brand, last4, authCode, refNum, recovered: recover } };

      // SAFETY NET: record the captured charge to our ledger IMMEDIATELY, before receipt/HawkSoft steps.
      // If anything downstream crashes, we still have proof the card was charged (flagged receipt_pending).
      // On success, the final audit() call updates the same record with full details.
      let safetyLedgerId = null;
      if (!recover) {
        try {
          const sUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
          const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
          if (sUrl && sKey) {
            const sr = await fetch(`${sUrl.replace(/\/$/, '')}/rest/v1/bridge_ledger`, {
              method: 'POST',
              headers: { apikey: sKey, Authorization: `Bearer ${sKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
              body: JSON.stringify({
                kind: 'charge_captured', client_id: Number.isFinite(parseInt(clientId, 10)) ? parseInt(clientId, 10) : null,
                amount: total, purpose: purpose ? String(purpose).slice(0, 120) : null,
                agent: who ? String(who).slice(0, 120) : null, txn_id: txnId,
                auth_code: authCode ? String(authCode) : null, ref: refNum || null,
                audit_status: auditStatusFor('charge_captured'),
                commission_to: normaliseAgentEmail((req.body||{}).commissionTo) || normaliseAgentEmail(who) || null,
                producer_code: (req.body||{}).producerCode ? String((req.body||{}).producerCode).slice(0, 8) : null,
                is_test: parseInt(clientId, 10) === TEST_CLIENT_ID,
                extra: { safety_net: true, receipt_pending: true, brand, last4, office },
              }),
            });
            const srj = await sr.json().catch(() => null);
            safetyLedgerId = srj && srj[0] ? srj[0].id : null;
          }
        } catch (e) { /* never block on the safety net itself */ }
      }

      // Resolve policy GUID + matching open invoice (fail-soft on both)
      let policyGuid = null, policyCarrier = null, policyProgram = null, invPick = { invoices: null, how: 'lookup failed' };
      try {
        const pc = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=details,policies,invoices`);
        if (policyNumber) {
          const pols = (pc.body && (pc.body.policies || pc.body.Policies)) || [];
          const want = policyNumber.toUpperCase();
          const hit = pols.find(pl => String(pl.policyNumber || pl.PolicyNumber || '').trim().toUpperCase() === want);
          if (hit) {
            policyGuid = hit.id || hit.policyId || hit.guid || hit.Id || null;
            policyCarrier = String(hit.carrier || hit.Carrier || hit.writingCarrier || '').trim().slice(0, 30) || null;
            // HawkSoft keeps the program separate from the carrier (ANCHOR GENERAL /
            // GEMINI). Carry it so the audit step can SHOW it without asking the agent
            // to pick something we already know.
            policyProgram = String(hit.program || hit.Program || '').trim().slice(0, 40) || null;
          }
        }
        invPick = pickInvoices(pc.body, total, policyGuid);
        if (!clientName) clientName = String(clientNameFrom(pc.body) || '').slice(0, 40);
        if (!b.clientEmail) b.clientEmail = emailFrom(pc.body);
      } catch { policyGuid = null; }
      out.policyLink = policyGuid ? 'linked' : (policyNumber ? 'no match — filed at client level' : 'no policy # given');
      out.invoiceApply = invPick.how;

      // 2) Accounting receipt
      const receipt = [{
        refId: crypto.randomUUID(), ts: now.toISOString(), channel: 29, // Online From Insured — the payer
        payMethod: 'CreditCard', total, policyId: policyGuid,
        ...(invPick.invoices ? { invoices: invPick.invoices } : {}),
        logNote: `CHARGE PAGE receipt — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · Clover ${txnId}${authCode ? ' auth ' + authCode : ''} · ${brand} ****${last4}. Charged via Speedy payment bridge.`,
      }];
      if (!invPick.invoices && taskEmail) {
        receipt[0].task = {
          title: `Invoice needed — payment $${total.toFixed(2)}`.slice(0, 50),
          description: `Payment of $${total.toFixed(2)} (${purpose}) on client #${clientId}${policyNumber ? ', policy ' + policyNumber : ''} had no matching open invoice (${invPick.how}). Create the invoice in Trust Accounting and apply Clover ${txnId}.`,
          dueDate: now.toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: taskEmail,
        };
      }
      let r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt) });
      if (!(r1.status === 200 || r1.status === 202) && receipt[0].task) {
        delete receipt[0].task; // never lose the payment record over a task problem
        r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
          method: 'POST', body: JSON.stringify(receipt) });
        out.taskDropped = true;
      }
      out.receipt = { ok: r1.status === 200 || r1.status === 202, status: r1.status };
      out.followUpTask = receipt[0].task ? `assigned to ${taskEmail}` : (invPick.invoices ? 'not needed — invoice applied' : 'none');

      // 3) Branded receipt PDF -> attachment + vault (shared: buildReceiptPdf / fileReceiptPdf)
      const pdfBuf = await buildReceiptPdf({
        total, stamp, clientName, clientId, purpose, policyNumber, policyCarrier,
        branchName: b.branchName || 'Speedy Insurance Agency',
        headline: 'APPROVED',
        detailRows: [
          ['Card', `${brand} **** ${last4}`],
          ['Entry method', 'Keyed \u2014 secure online form'],
          ['Cardholder verification', 'Online \u2014 CVV verified'],
        ],
        recordTitle: 'CLOVER / FISERV TRANSACTION RECORD',
        recordRows: [
          ['Clover transaction ID', txnId.slice(0, 30)],
          ...(authCode ? [['Auth code', String(authCode)]] : []),
          ...(refNum ? [['Reference #', String(refNum)]] : []),
          ['Merchant ID', '1K7NR5V6K1ER1'],
          ['Device', 'Web \u2014 Speedy payment bridge'],
          ['Charged by', who.slice(0, 42)],
        ],
        footerLines: ['All fields above are drawn from the Clover/Fiserv',
          'transaction record and tie 1:1 to the processor\u2019s',
          'system of record (transaction ID + auth code).', '',
          'Filed automatically to the HawkSoft client record', 'by the Speedy payment bridge.'],
      });
      const filedLive = await fileReceiptPdf({ hs, clientId, pdfBuf, now, total, who, policyGuid, txnId,
        filePrefix: 'Clover_Receipt', desc: `Clover receipt $${total.toFixed(2)}`,
        logNoteTail: `Charged by ${who}. Clover ${txnId}.` });
      out.attachment = filedLive.attachment;
      out.vault = filedLive.vault;

      // 4) Summary log note
      const r3 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify({
          refId: crypto.randomUUID(), ts: now.toISOString(), channel: 32, // Online From 3rd Party — the bridge
          policyId: policyGuid, PolicyId: policyGuid,
          note: `CHARGE PAGE LIVE — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · Clover ${txnId}${authCode ? ' auth ' + authCode : ''} · ${brand} ****${last4}. Receipt posted + branded PDF attached.`,
        }) });
      out.log = { ok: r3.status === 200 || r3.status === 202, status: r3.status };

      out.confirmationEmail = await sendConfirmEmail({
        to: String(b.clientEmail || '').trim(), name: (clientName || '').split(',').pop().trim().split(' ')[0],
        amount: total, purpose, method: `${brand} ****${last4}`, confirmation: txnId, stamp });
      // Finalize: update the safety-net row with full details (or create fresh if no safety row / recovery)
      let auditSaved = false;
      if (safetyLedgerId) {
        try {
          const sUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
          const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
          const pr = await fetch(`${sUrl.replace(/\/$/, '')}/rest/v1/bridge_ledger?id=eq.${safetyLedgerId}`, {
            method: 'PATCH', headers: { apikey: sKey, Authorization: `Bearer ${sKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              kind: action, purpose: purpose ? String(purpose).slice(0, 120) : null,
              invoice_status: out.invoiceApply || null,
              extra: { safety_net: true, receipt_pending: false, finalized: true, brand, last4,
                       receipt: out.receipt, attachment: out.attachment, log: out.log,
                       followUpTask: out.followUpTask, confirmationEmail: out.confirmationEmail,
                       /* Recorded so "did this file under the policy or at client level?"
                          is answerable from our own data instead of by reading HawkSoft. */
                       policyNumber: policyNumber || null, policyLink: out.policyLink || null,
                       // the audit step reads these to prefill "Carrier paid" — without
                       // them the value is resolved here and then thrown away
                       policyCarrier: policyCarrier || null, policyProgram: policyProgram || null },
            }),
          });
          /* THE recurring bug, again. This used to assign a BOOLEAN, but the linking
             step below needs `auditSaved.id` — and `true.id` is undefined, so every
             card/terminal receipt PATCHed onto a safety-net row was stored with
             payment_id NULL and vanished from the Audit tab's per-payment doc list.
             67% of client receipts since Aug 17. We already HOLD the id we are
             patching (safetyLedgerId) — no need to ask PostgREST for it back, which
             `Prefer: return=minimal` would refuse to give anyway. */
          auditSaved = (pr.status === 200 || pr.status === 204) ? { id: safetyLedgerId } : false;
        } catch { auditSaved = false; }
      } else {
        auditSaved = await audit({ action, who, office, clientId, clientName, commissionTo: b.commissionTo, producerCode: b.producerCode, totalOwed: b.totalOwed, balanceOf: b.balanceOf, amount: total, purpose, txnId, authCode, brand, last4, policyNumber, policyGuid, policyCarrier, policyProgram, invoiceApply: out.invoiceApply, followUpTask: out.followUpTask, confirmationEmail: out.confirmationEmail, hawksoft: { receipt: out.receipt, attachment: out.attachment, log: out.log } });
      }
      // link this receipt to its ledger row so the viewer scopes files to the payment
      if (auditSaved && auditSaved.id && out.vault && out.vault.id) {
        await linkReceiptToPayment(out.vault.id, auditSaved.id);
      }
      return res.status(200).json({ ok: out.receipt.ok && out.attachment.ok && out.log.ok, results: out, txnId, authCode, auditSaved, ledgerId: (auditSaved && auditSaved.id) || null });
    }

    /* ---------- Diagnostics: raw invoice list for a client ---------- */
    if (action === 'probe_invoices') {
      const cid = parseInt((req.body || {}).clientId, 10);
      if (!cid) return res.status(400).json({ ok: false, error: 'clientId required' });
      const pc = await hs(`/vendor/agency/${AGENCY_ID}/client/${cid}?version=4.0&include=details,invoices`);
      const denied = null;
      return res.status(200).json({ ok: true, status: pc.status,
        invoices: (pc.body && (pc.body.invoices || pc.body.Invoices)) || [],
        keys: pc.body ? Object.keys(pc.body) : [] });
    }

    /* ---------- Charge page: record a CASH payment (no card, full HawkSoft trail) ---------- */
    if (action === 'charge_cash') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      if (!clientId || clientId < 1) return res.status(400).json({ ok: false, error: 'Verify and confirm the client in HawkSoft first.' });
      const total = Math.round(parseMoney(b.amount) * 100) / 100;
      if (!total || total < 0.5) return res.status(400).json({ ok: false, error: 'Amount must be at least $0.50.' });
      const purpose = String(b.purpose || 'Down payment').slice(0, 80);
      const note = String(b.note || '').slice(0, 120).trim();
      const payMethod = String(b.payMethod || 'Cash').slice(0, 20);
      // HawkSoft receipts only accept known payment methods; Zelle/Other are recorded as Cash to HawkSoft (real method kept in note/PDF)
      const hsPayMethod = (['cash','check'].includes(payMethod.toLowerCase())) ? payMethod : 'Cash';
      const altRef = String(b.altRef || '').slice(0, 80).trim();
      const office = String(b.office || '').slice(0, 40) || null; // branch the agent selected in the portal
      // purpose shown on receipt includes the note when present
      const purposeFull = note ? `${purpose} — ${note}` : purpose;
      const policyNumber = String(b.policyNumber || '').trim().slice(0, POLICY_NUM_MAX);
      const clientName = String(b.clientName || '').slice(0, 40);
      const who = userEmail ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail) : 'admin key';
      const taskEmail = userEmail || 'info@speedyins.com';
      const now = new Date();
      const stamp = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      // ref prefix by method: CASH- / ZELLE- / OTHER-
      const refPrefix = payMethod.toUpperCase() === 'ZELLE' ? 'ZELLE-' : payMethod.toUpperCase() === 'OTHER' ? 'OTHER-' : 'CASH-';
      const ref = altRef ? (refPrefix + altRef.replace(/[^a-z0-9]/gi, '').slice(0, 20).toUpperCase()) : (refPrefix + crypto.randomUUID().slice(0, 10).toUpperCase());
      const out = {};

      let policyGuid = null, policyCarrier = null, policyProgram = null, invPick = { invoices: null, how: 'lookup failed' };
      try {
        const pc = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=details,policies,invoices`);
        if (policyNumber) {
          const pols = (pc.body && (pc.body.policies || pc.body.Policies)) || [];
          const want = policyNumber.toUpperCase();
          const hit = pols.find(pl => String(pl.policyNumber || pl.PolicyNumber || '').trim().toUpperCase() === want);
          if (hit) {
            policyGuid = hit.id || hit.policyId || hit.guid || hit.Id || null;
            policyCarrier = String(hit.carrier || hit.Carrier || hit.writingCarrier || '').trim().slice(0, 30) || null;
            // HawkSoft keeps the program separate from the carrier (ANCHOR GENERAL /
            // GEMINI). Carry it so the audit step can SHOW it without asking the agent
            // to pick something we already know.
            policyProgram = String(hit.program || hit.Program || '').trim().slice(0, 40) || null;
          }
        }
        invPick = pickInvoices(pc.body, total, policyGuid);
        if (!b.clientEmail) b.clientEmail = emailFrom(pc.body);
      } catch { policyGuid = null; }
      out.policyLink = policyGuid ? 'linked' : (policyNumber ? 'no match — filed at client level' : 'no policy # given');
      out.invoiceApply = invPick.how;

      const receipt = [{
        refId: crypto.randomUUID(), ts: now.toISOString(), channel: 21, // Walk In From Insured
        payMethod: hsPayMethod, total, policyId: policyGuid,
        ...(invPick.invoices ? { invoices: invPick.invoices } : {}),
        logNote: `CHARGE PAGE ${payMethod} — $${total.toFixed(2)} · ${purposeFull}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · ref ${ref}. Recorded via Speedy payment bridge.`,
      }];
      if (!invPick.invoices && taskEmail) {
        receipt[0].task = {
          title: `Invoice needed — cash $${total.toFixed(2)}`.slice(0, 50),
          description: `${payMethod} payment of $${total.toFixed(2)} (${purposeFull}) on client #${clientId}${policyNumber ? ', policy ' + policyNumber : ''} had no matching open invoice (${invPick.how}). Create the invoice in Trust Accounting and apply ref ${ref}.`,
          dueDate: now.toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: taskEmail,
        };
      }
      let r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt) });
      if (!(r1.status === 200 || r1.status === 202) && receipt[0].task) {
        delete receipt[0].task;
        r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
          method: 'POST', body: JSON.stringify(receipt) });
        out.taskDropped = true;
      }
      out.receipt = { ok: r1.status === 200 || r1.status === 202, status: r1.status };
      out.followUpTask = receipt[0].task ? `assigned to ${taskEmail}` : (invPick.invoices ? 'not needed — invoice applied' : 'none');

      const pdfBuf = await buildReceiptPdf({
        total, stamp, clientName, clientId, purpose: purposeFull, policyNumber, policyCarrier,
        branchName: 'Speedy Insurance Agency',
        headline: 'RECEIVED \u2014 ' + payMethod.toUpperCase(),
        detailRows: [
          ['Method', payMethod],
          ['Entry', (payMethod.toLowerCase() === 'zelle') ? 'Zelle \u2014 bank transfer'
            : (payMethod.toLowerCase() === 'other') ? ('Other \u2014 ' + payMethod) : 'In person \u2014 counter'],
        ],
        recordTitle: 'PAYMENT RECORD',
        recordRows: [
          ['Reference', ref],
          ['Device', 'Web \u2014 Speedy payment bridge'],
          ['Received by', who.slice(0, 42)],
        ],
        footerLines: [
          (payMethod.toLowerCase() === 'zelle') ? 'Zelle payment received and'
            : (payMethod.toLowerCase() === 'cash') ? 'Cash payment received at the agency counter and'
            : (payMethod + ' payment received and'),
          'recorded to the HawkSoft client record by the', 'Speedy payment bridge.'],
      });
      const filedCash = await fileReceiptPdf({ hs, clientId, pdfBuf, now, total, who, policyGuid, txnId: ref,
        filePrefix: 'Cash_Receipt', desc: `Cash receipt $${total.toFixed(2)}`,
        logNoteTail: `Cash received by ${who}. Ref ${ref}.` });
      out.attachment = filedCash.attachment;
      out.vault = filedCash.vault;

      const r3 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify({
          refId: crypto.randomUUID(), ts: now.toISOString(), channel: 32,
          policyId: policyGuid, PolicyId: policyGuid,
          note: `CHARGE PAGE ${payMethod.toUpperCase()} — $${total.toFixed(2)} · ${purposeFull}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · ref ${ref}. Receipt posted + branded PDF attached.`,
        }) });
      out.log = { ok: r3.status === 200 || r3.status === 202, status: r3.status };

      out.confirmationEmail = await sendConfirmEmail({
        to: String(b.clientEmail || '').trim(), name: (clientName || '').split(',').pop().trim().split(' ')[0],
        amount: total, purpose, method: 'Cash — at our office', confirmation: ref, stamp });
      const auditSaved = await audit({ action: 'charge_cash', who, office, clientId, clientName, commissionTo: b.commissionTo, producerCode: b.producerCode, totalOwed: b.totalOwed, balanceOf: b.balanceOf, amount: total, purpose: purposeFull, ref, policyNumber, policyGuid, policyCarrier, policyProgram, invoiceApply: out.invoiceApply, followUpTask: out.followUpTask, confirmationEmail: out.confirmationEmail, hawksoft: out });
      // link this receipt to its ledger row so the viewer scopes files to the payment
      if (auditSaved && auditSaved.id && out.vault && out.vault.id) {
        await linkReceiptToPayment(out.vault.id, auditSaved.id);
      }
      return res.status(200).json({ ok: out.receipt.ok && out.attachment.ok && out.log.ok, results: out, ref, auditSaved, ledgerId: (auditSaved && auditSaved.id) || null });
    }

    /* ---------- Charge page: create a secure pay-by-link (72h, amount locked) ---------- */
    if (action === 'paylink_create') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      if (!clientId || clientId < 1) return res.status(400).json({ ok: false, error: 'Verify and confirm the client in HawkSoft first.' });
      const total = Math.round(parseMoney(b.amount) * 100) / 100;
      if (!total || total < 0.5) return res.status(400).json({ ok: false, error: 'Amount must be at least $0.50.' });
      const who = userEmail ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail) : 'admin key';
      const byShort = String(userEmail || 'admin').replace('@speedyins.com', '');
      // Resolve policy GUID so the creation log files under the exact policy tab (fail-soft)
      let linkPolicyGuid = null;
      const linkPolicyNumber = String(b.policyNumber || '').trim();
      if (linkPolicyNumber) {
        try {
          const pc = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=details,policies`);
          const pols = (pc.body && (pc.body.policies || pc.body.Policies)) || [];
          const want = linkPolicyNumber.toUpperCase();
          const hit = pols.find(pl => String(pl.policyNumber || pl.PolicyNumber || '').trim().toUpperCase() === want);
          if (hit) linkPolicyGuid = hit.id || hit.policyId || hit.guid || hit.Id || null;
        } catch { linkPolicyGuid = null; }
      }
      const tok = makeToken({
        c: clientId, a: total, p: String(b.purpose || 'Payment').slice(0, 40),
        pol: String(b.policyNumber || '').trim().slice(0, POLICY_NUM_MAX),
        by: byShort, exp: Date.now() + 72 * 3600 * 1000,
      }, KEY);
      // Auto-log the link creation to the client file
      const expStr = new Date(Date.now() + 72 * 3600 * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const lg = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify({
          refId: crypto.randomUUID(), ts: new Date().toISOString(), channel: 32,
          policyId: linkPolicyGuid, PolicyId: linkPolicyGuid,
          note: `PAYMENT LINK created — $${total.toFixed(2)} for ${String(b.purpose || 'Payment').slice(0, 40)}${b.policyNumber ? ' · policy ' + String(b.policyNumber).trim() : ''} · by ${who} · expires ${expStr} PT. Client pays online; trail files automatically when paid.`,
        }) });
      await audit({ action: 'paylink_create', who, office: String(b.office || '').slice(0, 40) || null, clientId, amount: total, purpose: b.purpose, logged: lg.status });
      return res.status(200).json({ ok: true, url: `https://www.speedyins.com/pay.html?t=${tok}`, hours: 72, logged: lg.status === 200 || lg.status === 202 });
    }

    /* ---------- Public (token-auth): pay page bootstrap ---------- */
    if (action === 'paylink_info') {
      const tok = readToken((req.body || {}).t, KEY);
      if (!tok) return res.status(400).json({ ok: false, error: 'This payment link is invalid or has expired. Please ask your agent for a new one.' });
      // Fast path: no HawkSoft call here — the page fetches the name separately in parallel
      return res.status(200).json({ ok: true, name: tok.n || '', amount: tok.a, purpose: tok.p || 'Payment',
        pk: process.env.CLOVER_ECOMM_PUBLIC || null, merchantId: '1K7NR5V6K1ER1' });
    }

    /* ---------- Public (token-auth): client display name, fetched async by pay.html ---------- */
    if (action === 'paylink_name') {
      const tok = readToken((req.body || {}).t, KEY);
      if (!tok) return res.status(400).json({ ok: false });
      let name = tok.n || '';
      if (!name) {
        try {
          const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${parseInt(tok.c, 10)}?version=4.0&include=Details,People`);
          name = clientNameFrom(r.body);
        } catch { name = ''; }
      }
      return res.status(200).json({ ok: true, name });
    }

    /* ---------- Terminal: branch/device list for the picker ---------- */
    if (action === 'terminal_config') {
      const branches = Object.entries(CLOVER_BRANCHES).map(([k, v]) => ({
        id: k, branch: v.branch, merchantId: v.merchantId, device: v.device, model: v.model }));
      return res.status(200).json({ ok: true, branches, raid: '0EFKFNBWHCSAM.9PSNNM5VC2456' });
    }

    /* ---------- Terminal: send a payment to a branch Flex (REST Pay Display) ---------- */
    if (action === 'terminal_charge') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      if (!clientId || clientId < 1) return res.status(400).json({ ok: false, error: 'Verify and confirm the client first.' });
      const total = Math.round(parseMoney(b.amount) * 100) / 100;
      if (!total || total < 0.5) return res.status(400).json({ ok: false, error: 'Amount must be at least $0.50.' });
      const branch = CLOVER_BRANCHES[String(b.branchId || '1')] || CLOVER_BRANCHES[1];
      const purpose = ((n)=>{ const p=String(b.purpose||'Down payment').slice(0,80); return n?`${p} — ${n}`:p; })(String(b.note||'').slice(0,120).trim());
      const policyNumber = String(b.policyNumber || '').trim().slice(0, POLICY_NUM_MAX);
      let clientName = String(b.clientName || '').slice(0, 40);
      const who = userEmail ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail) : 'admin key';
      const now = new Date();
      const stamp = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });

      const auth = await getCloverToken(branch.merchantId);
      if (!auth.token) return res.status(400).json({ ok: false, error: auth.error || 'No terminal authorization on file for this branch.' });

      // Fire the payment to the device — waits for the customer to tap/insert
      const extId = 'SPB' + Date.now();
      const cr = await fetch('https://scl.clover.com/v1/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          'X-Clover-Device-Id': branch.device,
          'X-POS-ID': '0EFKFNBWHCSAM.9PSNNM5VC2456', // production RAID
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ amount: Math.round(total * 100), final: true, externalPaymentId: extId }),
      });
      const ctext = await cr.text();
      let cbody = null; try { cbody = ctext ? JSON.parse(ctext) : null; } catch { cbody = ctext; }
      const pay = cbody && (cbody.payment || cbody);
      const paid = cr.status === 200 && pay && (pay.result === 'SUCCESS' || pay.result === 'APPROVED' || pay.status === 'SUCCESS');
      if (!paid) {
        const msg = (pay && (pay.result === 'FAIL' && pay.failureMessage)) || (pay && (pay.result || pay.message))
          || (cbody && cbody.message) || `Terminal returned HTTP ${cr.status}`;
        const alerted = await sendDeclineAlert({ to: userEmail || 'info@speedyins.com', amount: total, clientId, clientName, purpose,
          reason: String(msg), channel: `Terminal — ${branch.branch}` });
        await audit({ action: 'terminal_declined', who, clientId, amount: total, purpose, reason: String(msg), alerted, branch: branch.branch, cloverStatus: cr.status, clover: cbody });
        return res.status(402).json({ ok: false, error: `Terminal payment not completed: ${msg}` });
      }
      const txnId = String(pay.id || extId);
      const authCode = (pay.cardTransaction && pay.cardTransaction.authCode) || null;
      const refNum = (pay.cardTransaction && pay.cardTransaction.referenceId) || null;
      const brand = String((pay.cardTransaction && pay.cardTransaction.cardType) || 'CARD').toUpperCase();
      const last4 = String((pay.cardTransaction && pay.cardTransaction.last4) || '????');
      const out = { charge: { ok: true, id: txnId, amount: total, brand, last4, authCode, refNum, branch: branch.branch } };

      // SAFETY NET (same as card): record captured terminal charge immediately, before receipt/HawkSoft.
      let safetyLedgerId = null;
      try {
        const sUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
        const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
        if (sUrl && sKey) {
          const sr = await fetch(`${sUrl.replace(/\/$/, '')}/rest/v1/bridge_ledger`, {
            method: 'POST',
            headers: { apikey: sKey, Authorization: `Bearer ${sKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
            body: JSON.stringify({
              kind: 'charge_captured', client_id: Number.isFinite(parseInt(clientId, 10)) ? parseInt(clientId, 10) : null,
              amount: total, purpose: purpose ? String(purpose).slice(0, 120) : null,
              agent: who ? String(who).slice(0, 120) : null, txn_id: txnId,
              auth_code: authCode ? String(authCode) : null, ref: refNum || null,
              audit_status: auditStatusFor('charge_captured'),
              commission_to: normaliseAgentEmail((req.body||{}).commissionTo) || normaliseAgentEmail(who) || null,
              producer_code: (req.body||{}).producerCode ? String((req.body||{}).producerCode).slice(0, 8) : null,
              is_test: parseInt(clientId, 10) === TEST_CLIENT_ID,
              extra: { safety_net: true, receipt_pending: true, terminal: true, branch: branch.branch, office: String((req.body||{}).office || branch.branch || '').slice(0, 40) || null, brand, last4 },
            }),
          });
          const srj = await sr.json().catch(() => null);
          safetyLedgerId = srj && srj[0] ? srj[0].id : null;
        }
      } catch (e) { /* never block on the safety net */ }
      let policyGuid = null, policyCarrier = null, policyProgram = null, invPick = { invoices: null, how: 'lookup failed' };
      try {
        const pc = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=details,policies,invoices`);
        if (policyNumber) {
          const pols = (pc.body && (pc.body.policies || pc.body.Policies)) || [];
          const want = policyNumber.toUpperCase();
          const hit = pols.find(pl => String(pl.policyNumber || pl.PolicyNumber || '').trim().toUpperCase() === want);
          if (hit) {
            policyGuid = hit.id || hit.policyId || hit.guid || hit.Id || null;
            policyCarrier = String(hit.carrier || hit.Carrier || hit.writingCarrier || '').trim().slice(0, 30) || null;
            // HawkSoft keeps the program separate from the carrier (ANCHOR GENERAL /
            // GEMINI). Carry it so the audit step can SHOW it without asking the agent
            // to pick something we already know.
            policyProgram = String(hit.program || hit.Program || '').trim().slice(0, 40) || null;
          }
        }
        invPick = pickInvoices(pc.body, total, policyGuid);
        if (!clientName) clientName = String(clientNameFrom(pc.body) || '').slice(0, 40);
        if (!b.clientEmail) b.clientEmail = emailFrom(pc.body);
      } catch { policyGuid = null; }
      out.policyLink = policyGuid ? 'linked' : (policyNumber ? 'no match — filed at client level' : 'no policy # given');
      out.invoiceApply = invPick.how;

      const receipt = [{
        refId: crypto.randomUUID(), ts: now.toISOString(), channel: 21, // Walk In From Insured — counter payment
        payMethod: 'CreditCard', total, policyId: policyGuid,
        ...(invPick.invoices ? { invoices: invPick.invoices } : {}),
        logNote: `CHARGE PAGE terminal — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · ${branch.branch} Flex · Clover ${txnId}${authCode ? ' auth ' + authCode : ''} · ${brand} ****${last4}. Card-present via Speedy payment bridge.`,
      }];
      if (!invPick.invoices && userEmail) {
        receipt[0].task = {
          title: `Invoice needed — payment $${total.toFixed(2)}`.slice(0, 50),
          description: `Terminal payment of $${total.toFixed(2)} (${purpose}) on client #${clientId}${policyNumber ? ', policy ' + policyNumber : ''} had no matching open invoice (${invPick.how}). Create the invoice in Trust Accounting and apply Clover ${txnId}.`,
          dueDate: now.toISOString(), assignedToRole: 'SpecifiedUser', assignedToEmail: userEmail,
        };
      }
      let r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt) });
      if (!(r1.status === 200 || r1.status === 202) && receipt[0].task) {
        delete receipt[0].task;
        r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
          method: 'POST', body: JSON.stringify(receipt) });
      }
      out.receipt = { ok: r1.status === 200 || r1.status === 202, status: r1.status };

      // Branded receipt PDF -> attachment + vault. Terminal previously skipped this
      // entirely, so card-present charges filed a receipt + log but no PDF.
      const pdfBuf = await buildReceiptPdf({
        total, stamp, clientName, clientId, purpose, policyNumber, policyCarrier,
        branchName: branch.branch ? ('Speedy Insurance \u2014 ' + branch.branch) : 'Speedy Insurance Agency',
        headline: 'APPROVED',
        detailRows: [
          ['Card', `${brand} **** ${last4}`],
          ['Entry method', 'Card present \u2014 Clover terminal'],
          ['Terminal', branch.branch ? (branch.branch + ' Flex') : 'Clover Flex'],
        ],
        recordTitle: 'CLOVER / FISERV TRANSACTION RECORD',
        recordRows: [
          ['Clover transaction ID', String(txnId).slice(0, 30)],
          ...(authCode ? [['Auth code', String(authCode)]] : []),
          ['Merchant ID', '1K7NR5V6K1ER1'],
          ['Device', 'Clover Flex \u2014 Speedy payment bridge'],
          ['Charged by', who.slice(0, 42)],
        ],
        footerLines: ['All fields above are drawn from the Clover/Fiserv',
          'transaction record and tie 1:1 to the processor\u2019s',
          'system of record (transaction ID + auth code).', '',
          'Filed automatically to the HawkSoft client record', 'by the Speedy payment bridge.'],
      });
      const filedTerm = await fileReceiptPdf({ hs, clientId, pdfBuf, now, total, who, policyGuid, txnId,
        filePrefix: 'Clover_Terminal_Receipt', desc: `Terminal receipt $${total.toFixed(2)}`,
        logNoteTail: `Card present via ${branch.branch || 'Clover'} Flex. Charged by ${who}. Clover ${txnId}.` });
      out.attachment = filedTerm.attachment;
      out.vault = filedTerm.vault;

      const r3 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify({
          refId: crypto.randomUUID(), ts: now.toISOString(), channel: 32,
          policyId: policyGuid, PolicyId: policyGuid,
          note: `CHARGE PAGE TERMINAL — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · ${branch.branch} Flex (${branch.device}) · Clover ${txnId}${authCode ? ' auth ' + authCode : ''} · ${brand} ****${last4}. Receipt posted.`,
        }) });
      out.log = { ok: r3.status === 200 || r3.status === 202, status: r3.status };

      out.confirmationEmail = await sendConfirmEmail({
        to: String(b.clientEmail || '').trim(), name: (clientName || '').split(',').pop().trim().split(' ')[0],
        amount: total, purpose, method: `${brand} ****${last4} — ${branch.branch} terminal`, confirmation: txnId, stamp });
      let auditSaved = false;
      if (safetyLedgerId) {
        try {
          const sUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
          const sKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
          const pr = await fetch(`${sUrl.replace(/\/$/, '')}/rest/v1/bridge_ledger?id=eq.${safetyLedgerId}`, {
            method: 'PATCH', headers: { apikey: sKey, Authorization: `Bearer ${sKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              kind: 'terminal_charge', purpose: purpose ? String(purpose).slice(0, 120) : null,
              invoice_status: out.invoiceApply || null,
              extra: { safety_net: true, receipt_pending: false, finalized: true, terminal: true, branch: branch.branch, brand, last4, receipt: out.receipt, log: out.log, confirmationEmail: out.confirmationEmail,
                       policyNumber: policyNumber || null, policyLink: out.policyLink || null,
                       // the audit step reads these to prefill "Carrier paid" — without
                       // them the value is resolved here and then thrown away
                       policyCarrier: policyCarrier || null, policyProgram: policyProgram || null },
            }),
          });
          /* THE recurring bug, again. This used to assign a BOOLEAN, but the linking
             step below needs `auditSaved.id` — and `true.id` is undefined, so every
             card/terminal receipt PATCHed onto a safety-net row was stored with
             payment_id NULL and vanished from the Audit tab's per-payment doc list.
             67% of client receipts since Aug 17. We already HOLD the id we are
             patching (safetyLedgerId) — no need to ask PostgREST for it back, which
             `Prefer: return=minimal` would refuse to give anyway. */
          auditSaved = (pr.status === 200 || pr.status === 204) ? { id: safetyLedgerId } : false;
        } catch { auditSaved = false; }
      } else {
        auditSaved = await audit({ action: 'terminal_charge', who, office: String((req.body||{}).office || branch.branch || '').slice(0, 40) || null, clientId, clientName, commissionTo: (req.body||{}).commissionTo, producerCode: (req.body||{}).producerCode, totalOwed: (req.body||{}).totalOwed, balanceOf: (req.body||{}).balanceOf, amount: total, purpose, txnId, authCode, brand, last4, policyNumber, policyGuid, policyCarrier, policyProgram, branch: branch.branch, invoiceApply: out.invoiceApply, confirmationEmail: out.confirmationEmail, hawksoft: { receipt: out.receipt, attachment: out.attachment, log: out.log } });
      }
      // link this receipt to its ledger row so the viewer scopes files to the payment
      if (auditSaved && auditSaved.id && out.vault && out.vault.id) {
        await linkReceiptToPayment(out.vault.id, auditSaved.id);
      }
      return res.status(200).json({ ok: out.receipt.ok && out.attachment.ok && out.log.ok, results: out, txnId, authCode, auditSaved, ledgerId: (auditSaved && auditSaved.id) || null });
    }

    if (action === 'charge_full_test') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      if (clientId !== 26081) {
        return res.status(400).json({ ok: false, error: 'Full-trail test is limited to ZZTEST client #26081.' });
      }
      const total = Math.round(parseMoney(b.amount, 1) * 100) / 100;
      if (!total || total <= 0 || total > 10) {
        return res.status(400).json({ ok: false, error: 'Test amounts capped at $10.00' });
      }
      const purpose = ((n)=>{ const p=String(b.purpose||'Down payment').slice(0,80); return n?`${p} — ${n}`:p; })(String(b.note||'').slice(0,120).trim());
      const policyNumber = String(b.policyNumber || '').trim().slice(0, POLICY_NUM_MAX);
      const who = userEmail
        ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail})` : userEmail)
        : 'admin key';
      const now = new Date();
      const stamp = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const txnId = 'TEST-' + crypto.randomUUID().slice(0, 12).toUpperCase();
      const out = {};

      // 1) Accounting receipt
      const receipt = [{
        refId: crypto.randomUUID(), ts: now.toISOString(), channel: 29, // Online From Insured — the payer
        payMethod: 'CreditCard', total,
        logNote: `CHARGE PAGE receipt — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · txn ${txnId}. TEST — safe to void.`,
      }];
      const r1 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt) });
      out.receipt = { ok: r1.status === 200 || r1.status === 202, status: r1.status };

      // 2) Receipt PDF -> Attachments (branded design — ported from the approved sample)
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      const W = 306, H = 590; // 4.25in x 8.2in receipt
      const page = doc.addPage([W, H]);
      const helv = await doc.embedFont(StandardFonts.Helvetica);
      const bold = await doc.embedFont(StandardFonts.HelveticaBold);
      const boldObl = await doc.embedFont(StandardFonts.HelveticaBoldOblique);
      const obl = await doc.embedFont(StandardFonts.HelveticaOblique);
      const RED = rgb(0.83, 0.17, 0.17), NAVY = rgb(0.10, 0.14, 0.34), GRAY = rgb(0.4, 0.4, 0.4),
            LIGHT = rgb(0.6, 0.6, 0.6), GREEN = rgb(0.13, 0.63, 0.35), BLACK = rgb(0, 0, 0),
            LINE = rgb(0.8, 0.8, 0.8);
      const ctr = (t, y, f, s, c) => page.drawText(t, { x: (W - f.widthOfTextAtSize(t, s)) / 2, y, font: f, size: s, color: c });
      const dash = y => page.drawLine({ start: { x: 25, y }, end: { x: W - 25, y }, thickness: 1, color: LINE, dashArray: [2, 2] });
      const solid = y => page.drawLine({ start: { x: 25, y }, end: { x: W - 25, y }, thickness: 1, color: LINE });
      let y = H - 32;
      ctr('SPEEDY', y, boldObl, 15, NAVY); y -= 19;
      ctr('INSURANCE AGENCY', y, boldObl, 17, RED); y -= 15;
      ctr(b.branchName || 'Speedy Insurance Agency', y, helv, 8, GRAY); y -= 11;
      ctr('(951) 472-0927  ·  speedyins.com', y, helv, 8, GRAY); y -= 16;
      dash(y); y -= 20;
      ctr('PAYMENT RECEIPT (TEST)', y, bold, 11, NAVY); y -= 26;
      ctr(`$${total.toFixed(2)}`, y, bold, 26, BLACK); y -= 15;
      ctr('APPROVED', y, bold, 9, GREEN); y -= 22;
      const row = (label, value, isBold) => {
        page.drawText(label, { x: 29, y, font: helv, size: 8.5, color: GRAY });
        const f = isBold ? bold : helv;
        const vw = f.widthOfTextAtSize(value, 8.5);
        page.drawText(value, { x: W - 29 - vw, y, font: f, size: 8.5, color: BLACK });
        y -= 12;
      };
      row('Date / Time', stamp + ' PT');
      row('Client', 'ZZTEST DELETE ME - API TEST', true);
      row('Client #', '26081');
      row('Payment for', purpose.slice(0, 38));
      if (policyNumber) row('Policy #', policyNumber, true);
      y -= 4; dash(y); y -= 14;
      row('Card', 'VISA **** 4242 (TEST)');
      row('Entry method', 'Chip (EMV)');
      row('Cardholder verification', 'Signature captured on device');
      y -= 4; solid(y); y -= 14;
      page.drawText('CLOVER / FISERV TRANSACTION RECORD', { x: 29, y, font: bold, size: 8.5, color: NAVY }); y -= 13;
      row('Clover transaction ID', txnId);
      row('Merchant ID', '1K7NR5V6K1ER1');
      row('Charged by', who.slice(0, 42));
      y -= 4; solid(y); y -= 16;
      for (const t of ['All fields above are drawn from the Clover/Fiserv', 'transaction record and tie 1:1 to the processor\u2019s', 'system of record (transaction ID + auth code).', '', 'Filed automatically to the HawkSoft client record', 'by the Speedy payment bridge.  (TEST — no money moved)']) {
        if (t) ctr(t, y, obl, 7, LIGHT); y -= 9;
      }
      y -= 6;
      ctr('Thank you for choosing Speedy Insurance!', y, bold, 8, NAVY);
      const pdfBuf = Buffer.from(await doc.save());

      const { gzipSync } = await import('node:zlib');
      const b64h = s => Buffer.from(s, 'utf8').toString('base64');
      const fname = `Clover_Receipt_TEST_${now.toISOString().slice(0, 10)}_${String(total.toFixed(2)).replace('.', '-')}usd`;
      const r2 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/attachment?version=4.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          RefId: crypto.randomUUID(), TS: now.toISOString(),
          Desc: b64h(`Clover receipt $${total.toFixed(2)} (TEST)`.slice(0, 41)),
          LogNote: b64h(`Receipt PDF "${fname}.pdf" filed by the Speedy payment bridge (TEST). Charged by ${who}.`),
          FileName: b64h(fname), FileExt: 'pdf', Channel: '32', // Online From 3rd Party
        },
        body: gzipSync(pdfBuf),
      });
      out.attachment = { ok: r2.status === 200 || r2.status === 202, status: r2.status, ...(r2.status >= 400 ? { error: r2.body } : {}) };
      // Also store the receipt PDF in OUR vault so it shows in the Audit tab
      out.vault = await storeReceiptVault({ clientId, pdfBuf, filename: fname, amount: total, txnId: (typeof txnId!=='undefined'?txnId:(typeof ref!=='undefined'?ref:null)), who, policyGuid });

      // 3) Summary log note
      const r3 = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify({
          refId: crypto.randomUUID(), ts: now.toISOString(), channel: 32, // Online From 3rd Party — the bridge
          note: `CHARGE PAGE full-trail TEST — $${total.toFixed(2)} · ${purpose}${policyNumber ? ' · policy ' + policyNumber : ''} · by ${who} · txn ${txnId}. Receipt posted + PDF attached. No money moved.`,
        }) });
      out.log = { ok: r3.status === 200 || r3.status === 202, status: r3.status };

      const auditSaved = await audit({ action: 'charge_full_test', who, clientId, amount: total, purpose, txnId, hawksoft: out });
      return res.status(200).json({ ok: out.receipt.ok && out.attachment.ok && out.log.ok, results: out, txnId, auditSaved });
    }

    /* ---------- Charge page: test write — restricted to ZZTEST #26081 in this phase ---------- */
    if (action === 'charge_log') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (clientId !== 26081) {
        return res.status(400).json({ ok: false, error: 'Charge-page test writes are limited to ZZTEST client #26081 in this phase.' });
      }
      const { amount, purpose, agent } = req.body || {};
      const payload = {
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 29,
        note: (() => {
          const who = userEmail
            ? (STAFF[userEmail] ? `${STAFF[userEmail][0]} (${userEmail}) — ${STAFF[userEmail][1]}` : userEmail)
            : `admin key${agent ? ' — ' + String(agent) : ''}`;
          return `CHARGE PAGE TEST — $${String(amount || '0.00')} · ${String(purpose || 'Payment')} · by ${who}. HawkLink launch test — no money moved. Safe to ignore.`;
        })(),
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'create_test_client') {
      const now = new Date().toISOString();
      const payload = {
        officeId: 1, // Moreno Valley
        status: 'Lead',
        source: 'Website',
        people: [{
          firstName: 'ZZTEST',
          lastName: 'DELETE ME - API TEST',
          mainContactType: 'First',
          contacts: [
            { type: 'CellPhone', value: '951-555-0199' },
            { type: 'HomeEmail', value: 'apitest@speedyins.com' },
          ],
        }],
        mailingAddress: { address1: '12625 Frederick St #i-1', city: 'Moreno Valley', state: 'CA', zip: '92553' },
        log: {
          channel: 29, // Online From Insured
          note: 'TEST RECORD — created via Partner API from the admin Test Lab to validate website lead intake. Safe to delete.',
          ts: now,
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: r.body });
    }

    if (action === 'add_log') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      const withTask = !!(req.body || {}).withTask;
      const now = new Date();
      const payload = {
        refId: crypto.randomUUID(),
        ts: now.toISOString(),
        channel: 29, // Online From Insured
        note: 'TEST LOG — written via Partner API from the admin Test Lab. This simulates a website-lead activity note. Safe to ignore.',
      };
      if (withTask) {
        payload.task = {
          title: 'TEST task — API Test Lab',
          description: 'Follow up on the test website lead. Created via Partner API. Safe to complete/delete.',
          dueDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          assignedToRole: 'CSR',
        };
      }
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'lookup_client') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=Details,People,Contacts`, {});
      if (r.status !== 200) return res.status(200).json({ ok: false, httpStatus: r.status, result: r.body });
      // PII SAFETY: return the SHAPE of the record, values masked (letters→X, digits→#).
      return res.status(200).json({ ok: true, httpStatus: 200, result: mask(r.body) });
    }

    if (action === 'search_policy') {
      const pol = String((req.body || {}).policyNumber || '').trim();
      if (!pol) return res.status(400).json({ ok: false, error: 'policyNumber required' });
      const r = await hs(`/vendor/agency/${AGENCY_ID}/clients/search?version=4.0&policyNumber=${encodeURIComponent(pol)}&include=Details`, {});
      if (r.status !== 200) return res.status(200).json({ ok: false, httpStatus: r.status, result: r.body });
      const matches = Array.isArray(r.body) ? r.body : [];
      // Return only client numbers + office — no PII.
      return res.status(200).json({
        ok: true, httpStatus: 200,
        result: { matches: matches.length, clients: matches.map(c => ({ clientNumber: c.clientNumber, officeId: c.details && c.details.officeId })) },
      });
    }

    if (action === 'attach_file') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      const ext = String(b.fileExt || '').toLowerCase().replace(/^\./, '');
      if (!['pdf', 'jpg', 'jpeg', 'png', 'mp3'].includes(ext)) {
        return res.status(400).json({ ok: false, error: 'File type must be pdf, jpg, jpeg, png, or mp3' });
      }
      if (!b.data) return res.status(400).json({ ok: false, error: 'File data missing' });
      const buf = Buffer.from(b.data, 'base64');
      if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'File exceeds HawkSoft 5 MB limit' });
      // HawkSoft's endpoint gzip-decompresses the body (undocumented — learned from their stack trace).
      const { gzipSync } = await import('node:zlib');
      const gz = gzipSync(buf);
      const name = String(b.fileName || 'upload').replace(/\.[^.]+$/, '').slice(0, 100) || 'upload';
      const desc = String(b.desc || 'Uploaded via Speedy admin drop zone').slice(0, 200);
      const b64 = s => Buffer.from(s, 'utf8').toString('base64');
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/attachment?version=4.0`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          RefId: crypto.randomUUID(),
          TS: new Date().toISOString(),
          Desc: b64(desc),
          LogNote: b64(`File "${name}.${ext}" uploaded via Speedy admin drop zone. ${desc}`),
          FileName: b64(name),
          FileExt: ext,
          Channel: '31', // Online From Agency Staff
        },
        body: gz,
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_recent_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const CTOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !CTOK) return res.status(200).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var in Vercel' });
      const r = await fetch(`https://api.clover.com/v3/merchants/${MID}/payments?limit=15&expand=tender,employee&orderBy=createdTime%20DESC`, {
        headers: { Authorization: `Bearer ${CTOK}` },
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const payments = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        time: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        tender: p.tender && p.tender.label,
        employee: p.employee && (p.employee.name || p.employee.id),
        note: p.note || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: payments.length, payments } });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 29, // Online From Insured
        logNote: 'TEST RECEIPT — $1.00 posted via Partner API from the admin Test Lab (Clover integration test). Not a real payment. Safe to void/delete.',
        total: 1.00,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const CMID = process.env.CLOVER_MERCHANT_ID;
      const CTOK = process.env.CLOVER_API_TOKEN;
      if (!CMID || !CTOK) return res.status(200).json({ ok: false, error: 'CLOVER_MERCHANT_ID / CLOVER_API_TOKEN env vars not set (or deployment predates them)' });
      const r = await fetch(`https://api.clover.com/v3/merchants/${CMID}/payments?limit=15&expand=tender,employee,order,cardTransaction&orderBy=createdTime%20DESC`, {
        headers: { Authorization: `Bearer ${CTOK}` },
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(200).json({ ok: false, error: `Clover HTTP ${r.status}`, detail: t.slice(0, 300) });
      }
      const data = await r.json();
      const payments = (data.elements || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        time: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        tender: p.tender && (p.tender.label || p.tender.labelKey) || null,
        last4: p.cardTransaction && p.cardTransaction.last4 || null,
        note: p.order && p.order.note || p.note || null,
        orderId: p.order && p.order.id || null,
      }));
      return res.status(200).json({ ok: true, merchant: CMID, count: payments.length, payments });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const amount = 1.00; // hard-coded test amount by design
      const receipt = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        policyId: null,
        officeId: null, // defaults to the client's office
        channel: 29, // Online From Insured
        logNote: 'TEST RECEIPT $1.00 — written via Partner API from the admin Test Lab to validate the Clover→HawkSoft accounting pipeline. Safe to void/delete.',
        total: amount,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt),
      });
      return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: r.body });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const amount = Math.min(Math.abs(parseFloat((req.body || {}).amount) || 1.0), 5.0); // test cap $5
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        policyId: null,
        officeId: null,
        channel: 31, // Online From Agency Staff
        logNote: `TEST RECEIPT — $${amount.toFixed(2)} posted via Partner API from the admin Test Lab to validate the Clover→HawkSoft receipt pipeline. Not a real payment. Safe to void/ignore.`,
        payMethod: 'Other',
        total: amount,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const TOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !TOK) return res.status(500).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var (redeploy needed after adding)' });
      const limit = Math.min(parseInt((req.body || {}).limit, 10) || 15, 50);
      const r = await fetch(
        `https://api.clover.com/v3/merchants/${MID}/payments?limit=${limit}&orderBy=createdTime%20DESC&expand=employee,order,cardTransaction`,
        { headers: { Authorization: `Bearer ${TOK}` } }
      );
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const pays = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        created: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        device: p.device && p.device.id || null,
        orderId: p.order && p.order.id || null,
        note: (p.note || (p.order && p.order.note) || '').slice(0, 120),
        last4: p.cardTransaction && p.cardTransaction.last4 || null,
        cardType: p.cardTransaction && p.cardTransaction.cardType || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: pays.length, payments: pays } });
    }

    if (action === 'create_receipt') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const total = Math.round(parseMoney(b.amount) * 100) / 100;
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!total || total <= 0 || total > 10) {
        return res.status(400).json({ ok: false, error: 'Test receipts are capped at $10.00 — amount must be between $0.01 and $10.00' });
      }
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 21, // Walk In From Insured
        payMethod: b.payMethod || 'CreditCard',
        logNote: String(b.logNote || 'TEST RECEIPT — posted via Partner API from the admin Test Lab (Clover integration test). Safe to void.').slice(0, 1000),
        total,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const TOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !TOK) return res.status(500).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var' });
      const url = `https://api.clover.com/v3/merchants/${MID}/payments?limit=15&orderBy=${encodeURIComponent('createdTime DESC')}&expand=${encodeURIComponent('employee,order,tender')}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TOK}` } });
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const payments = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        result: p.result,
        time: p.createdTime ? new Date(p.createdTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : null,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        tender: p.tender && (p.tender.label || p.tender.labelKey) || null,
        note: (p.order && p.order.note) || p.note || null,
        orderId: p.order && p.order.id || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: payments.length, payments } });
    }

    if (action === 'create_receipt') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const total = Math.round(parseFloat(b.total) * 100) / 100;
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!total || total <= 0 || total > 10000) return res.status(400).json({ ok: false, error: 'total must be between 0.01 and 10000' });
      const receipt = {
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 21, // Walk In From Insured
        logNote: String(b.logNote || `Payment receipt recorded via Speedy admin (Clover bridge test). Amount: $${total.toFixed(2)}`).slice(0, 3000),
        total,
      };
      if (b.payMethod) receipt.payMethod = String(b.payMethod);
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify([receipt]),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'smart_task') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      const email = String((req.body || {}).assignedToEmail || '').trim();
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!email) return res.status(400).json({ ok: false, error: 'assignedToEmail required (a HawkSoft user email)' });
      const now = new Date();
      // Simulates the output of AI extraction from the attached dec page (smart-intake pipeline).
      const payload = {
        refId: crypto.randomUUID(),
        ts: now.toISOString(),
        channel: 31,
        note: 'SMART INTAKE (TEST) \u2014 Dec page received, filed to attachments.\n'
          + 'EXTRACTED VALUES \u2014 double-click a value to copy:\n'
          + '\n'
          + 'Policy #: ZZT-PA-2026-0001\n'
          + 'Carrier: Kemper Auto\n'
          + 'LOB: Personal Auto\n'
          + 'Effective: 08/01/2026\n'
          + 'Expiration: 02/01/2027\n'
          + 'Term: 6 months\n'
          + 'Premium: 1842.00\n'
          + 'Named insured: ZZTEST DELETE ME - API TEST\n'
          + 'Vehicle: 2018 Toyota Camry LE\n'
          + 'VIN: 4T1B11HK5JU999999\n'
          + 'BI: 25/50\n'
          + 'PD: 25000\n'
          + 'UM: 25/50\n'
          + 'Comp ded: 500\n'
          + 'Coll ded: 500',
        task: {
          title: 'Enter policy from attached dec (TEST)',
          description: 'TEST of the smart-intake pipeline \u2014 no real policy exists.\n'
            + 'Enter in CMS \u2014 one value per line, ready to copy:\n'
            + '\n'
            + 'Policy #: ZZT-PA-2026-0001\n'
            + 'Carrier: Kemper Auto\n'
            + 'LOB: Personal Auto\n'
            + 'Effective: 08/01/2026\n'
            + 'Expiration: 02/01/2027\n'
            + 'Premium: 1842.00\n'
            + 'Vehicle: 2018 Toyota Camry LE\n'
            + 'VIN: 4T1B11HK5JU999999\n'
            + 'BI: 25/50 | PD: 25000 | UM: 25/50\n'
            + 'Comp/Coll ded: 500\n'
            + '\n'
            + 'Dec page PDF is in the client\u2019s Attachments tab.',
          dueDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: email,
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'create_client') {
      const b = req.body || {};
      const first = String(b.firstName || '').trim().slice(0, 14);
      const last = String(b.lastName || '').trim().slice(0, 24);
      if (!first || !last) return res.status(400).json({ ok: false, error: 'firstName and lastName required' });
      const officeId = parseInt(b.officeId, 10);
      if (!officeId && officeId !== 0) return res.status(400).json({ ok: false, error: 'officeId required' });
      const contacts = [];
      if (b.phone) contacts.push({ type: 'CellPhone', value: String(b.phone).trim().slice(0, 128) });
      if (b.email) contacts.push({ type: 'HomeEmail', value: String(b.email).trim().slice(0, 128) });
      const payload = {
        officeId,
        status: ['Active', 'Lead', 'Prospect'].includes(b.status) ? b.status : 'Lead',
        source: String(b.source || 'Speedy Intake').trim().slice(0, 14),
        people: [{
          firstName: first,
          lastName: last,
          mainContactType: 'First',
          ...(b.dob ? { dateOfBirth: String(b.dob).trim() } : {}),
          ...(contacts.length ? { contacts } : {}),
        }],
        ...(b.address1 ? {
          mailingAddress: {
            address1: String(b.address1).trim().slice(0, 40),
            city: String(b.city || '').trim().slice(0, 19),
            state: String(b.state || 'CA').trim().slice(0, 2),
            zip: String(b.zip || '').trim().slice(0, 10),
          },
        } : {}),
        ...(b.policyNumber ? {
          policy: {
            applicationType: ['Personal', 'Commercial', 'Life', 'Health'].includes(b.applicationType) ? b.applicationType : 'Personal',
            policyNumber: String(b.policyNumber).trim().slice(0, POLICY_NUM_MAX),
            ...(b.effectiveDate ? { effectiveDate: String(b.effectiveDate).trim() } : {}),
            ...(b.lob ? { LOBs: [mapLob(b.lob)] } : {}),
            state: 'CA',
          },
        } : {}),
        log: {
          channel: 31,
          note: 'Client created via Speedy admin intake' + (b.policyNumber ? ` with policy shell ${String(b.policyNumber).trim().slice(0, POLICY_NUM_MAX)}` : '') + '. Complete policy details in CMS from the dec page.',
          ts: new Date().toISOString(),
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: r.body });
    }

    if (action === 'intake_task') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const email = String(b.assignedToEmail || '').trim();
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!email) return res.status(400).json({ ok: false, error: 'assignedToEmail required' });
      const f = b.fields || {};
      const order = [
        ['policyNumber', 'Policy #'], ['carrier', 'Carrier'], ['lob', 'LOB'],
        ['effective', 'Effective'], ['expiration', 'Expiration'], ['premium', 'Premium'],
        ['vehicle', 'Vehicle'], ['vin', 'VIN'], ['coverages', 'Coverages'], ['notes', 'Notes'],
      ];
      const lines = order
        .filter(([k]) => f[k] && String(f[k]).trim())
        .map(([k, label]) => `${label}: ${String(f[k]).trim().slice(0, 120)}`);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'At least one extracted field required' });
      const block = lines.join('\n');
      const now = new Date();
      const payload = {
        refId: crypto.randomUUID(),
        ts: now.toISOString(),
        channel: 31,
        note: 'SMART INTAKE \u2014 Dec page received, filed to attachments.\nEXTRACTED VALUES \u2014 one per line, ready to copy:\n\n' + block,
        task: {
          title: 'Enter policy from attached dec',
          description: 'Enter in CMS \u2014 one value per line, ready to copy:\n\n' + block + '\n\nDec page PDF is in the client\u2019s Attachments tab.',
          dueDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: email,
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }

  /* ================= GET: non-PII aggregates ================= */
  const out = { ok: true, agencyId: AGENCY_ID, errors: [] };
  const get = async (path) => {
    const r = await hs(path);
    if (r.status === 204) return null;
    if (r.status !== 200) throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`);
    return r.body;
  };

  try {
    const agencies = await get('/vendor/agencies?version=4.0');
    const ours = (agencies || []).find(a => a.agencyId === AGENCY_ID);
    out.subscribed = !!ours;
    out.scopes = ours ? ours.scopes : [];
  } catch (e) { out.ok = false; out.errors.push('agencies ' + e.message); }

  try {
    const offices = await get(`/vendor/agency/${AGENCY_ID}/offices?version=4.0`);
    out.offices = (offices || []).map(o => ({
      id: o.officeId, name: o.officeDescription || o.subAgencyName || '(unnamed)',
      primary: !!o.primaryOffice,
      address: [o.addressLine1, o.city, o.state, o.zipcode].filter(Boolean).join(', '),
      archived: !!o.archived,
    }));
  } catch (e) { out.errors.push('offices ' + e.message); }

  const countSince = async (asOf) => {
    const q = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
    const ids = await get(`/vendor/agency/${AGENCY_ID}/clients?version=4.0${q}`);
    return Array.isArray(ids) ? ids.length : 0;
  };
  try {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const start7d = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const [total, today, week] = await Promise.all([countSince(null), countSince(startToday), countSince(start7d)]);
    out.clients = { total, changedToday: today, changedLast7Days: week };
  } catch (e) { out.errors.push('clients ' + e.message); }

  if (out.errors.length && out.subscribed === undefined) out.ok = false;
  return res.status(200).json(out);
}

/* Mask every string value: letters→X, digits→#. Keeps structure, kills PII. */
function mask(v) {
  if (v == null) return v;
  if (typeof v === 'string') {
    const m = v.replace(/[A-Za-z]/g, 'X').replace(/[0-9]/g, '#');
    return m.length > 40 ? m.slice(0, 40) + `…(${v.length} chars)` : m;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, 5).map(mask);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = mask(v[k]);
    return o;
  }
  return v;
}
