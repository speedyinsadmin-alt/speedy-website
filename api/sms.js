/* ---------------------------------------------------------------------------
   api/sms.js — send a text through RingCentral.

   The JWT auth, token cache and rate-limit hint are COPIED from rc-subscribe.js,
   which has been refreshing tokens against this same app for weeks. Rewriting an
   auth flow from memory is exactly how nine HawkSoft log notes were rejected on
   Sep 3; this is the proven shape.

   WHAT THIS DOES NOT DO YET, on purpose:
     - no receipt links. Receipts live in a PRIVATE bucket with no public URL, a
       decision made deliberately in August because a signed link works for anyone
       holding it. Texting a receipt needs that decision revisited first.
     - no marketing. Transactional only.

   Every send is recorded in `events` whether it succeeds or fails. An SMS cannot be
   unsent, so there must be a record of exactly what went to which number.
--------------------------------------------------------------------------- */

const RC_BASE = () => (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');

let tokenCache = { value: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const basic = Buffer.from(
    `${process.env.RC_CLIENT_ID}:${process.env.RC_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch(`${RC_BASE()}/restapi/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: process.env.RC_JWT,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = r.status === 429 ? ' (Auth limit is 5 requests/60s — wait a minute and retry once)' : '';
    throw new Error(`auth HTTP ${r.status}${hint}: ${j.error_description || j.error || ''}`);
  }
  tokenCache = { value: j.access_token, expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return j.access_token;
}

/* 10 digits, or 11 starting with 1. Anything else is refused rather than guessed —
   a text to the wrong number cannot be recalled. */
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

const sb = () => {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
};

async function record(row) {
  const s = sb();
  if (!s) return;
  try {
    await fetch(`${s.base}/rest/v1/events`, {
      method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify([row]),
    });
  } catch { /* a missing audit row must not fail the send that already happened */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = req.body || {};
  const action = String(body.action || 'send');

  /* Who is asking. Agents reach this with their portal token; the admin key is for
     testing from the Console. */
  let who = 'admin key';
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    const tok = req.headers['x-user-token'] || req.headers['x-id-token'];
    if (!tok) return res.status(401).json({ ok: false, error: 'Not authorized' });
    try {
      const g = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(String(tok))}`);
      const c = await g.json();
      const email = String(c.email || '').toLowerCase();
      if (!email.endsWith('@speedyins.com')) return res.status(401).json({ ok: false, error: 'Not authorized' });
      who = email;
    } catch { return res.status(401).json({ ok: false, error: 'Not authorized' }); }
  }

  /* Reports what the RingCentral app can actually do. Neither the SMS scope nor the
     sending number can be checked from outside, and guessing produces a confusing
     failure at send time instead of a clear answer now. */
  if (action === 'capabilities') {
    try {
      const token = await getAccessToken();
      const r = await fetch(`${RC_BASE()}/restapi/v1.0/account/~/extension/~/phone-number?perPage=100`,
        { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      const nums = (j.records || []).map(n => ({
        number: n.phoneNumber,
        label: n.label || null,
        usage: n.usageType || null,
        sms: !!(n.features || []).includes('SmsSender'),
        mms: !!(n.features || []).includes('MmsSender'),
      }));
      return res.status(200).json({
        ok: true, httpStatus: r.status,
        sms_capable_numbers: nums.filter(n => n.sms),
        all_numbers: nums,
        note: nums.some(n => n.sms)
          ? 'At least one number can send SMS. Set RC_SMS_FROM to it in Vercel.'
          : 'No number reports SmsSender. Either the app lacks the SMS scope, or no '
            + 'number is SMS-enabled in RingCentral. Both are fixed in the RingCentral '
            + 'admin console, not here.',
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (action === 'send') {
    const to = toE164(body.to);
    const text = String(body.text || '').trim();
    const from = process.env.RC_SMS_FROM;

    if (!to) return res.status(400).json({ ok: false, error: 'A 10-digit US number is required.' });
    if (!text) return res.status(400).json({ ok: false, error: 'The message is empty.' });
    if (text.length > 1000) return res.status(400).json({ ok: false, error: 'Message too long (1000 max).' });
    if (!from) return res.status(400).json({ ok: false, error: 'RC_SMS_FROM is not set in Vercel — run action:capabilities to find a number.' });

    let out;
    try {
      const token = await getAccessToken();
      const r = await fetch(`${RC_BASE()}/restapi/v1.0/account/~/extension/~/sms`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text }),
      });
      const j = await r.json().catch(() => ({}));
      out = { ok: r.status === 200, httpStatus: r.status, id: j.id || null,
              status: j.messageStatus || null, error: r.status === 200 ? null : (j.message || j.errorCode || 'send failed') };
    } catch (e) {
      out = { ok: false, error: String(e.message || e) };
    }

    /* Recorded either way. A text cannot be unsent, so what went where must be
       recoverable - the same reason every HawkSoft write is logged. */
    await record({
      actor: who, kind: out.ok ? 'sms.sent' : 'sms.failed', source: 'ringcentral',
      client_no: body.client_no ? Number(body.client_no) : null,
      payload: { to, from, chars: text.length, purpose: body.purpose || null,
                 message_id: out.id || null, status: out.status || null,
                 error: out.error || null },
    });

    return res.status(200).json(out);
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
