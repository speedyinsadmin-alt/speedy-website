/* ---------------------------------------------------------------------------
   api/lead.js — a lead from the public website lands in `leads`.

   PUBLIC. No key: the visitor is anonymous. What keeps it honest instead:
     - a honeypot field ("website") that a human never sees and a bot fills in;
       we answer ok:true and write nothing, so the bot learns nothing.
     - a per-instance rate limit by IP (10 a minute). Serverless instances do not
       share memory, so this is a speed bump, not a wall; the table is cheap.
     - hard caps on every string, and only known columns reach the row. Everything
       else the form sent goes into `fields` jsonb, so a new checkbox on a page
       never needs a migration.

   The Supabase shape is copied from sms.js: service key, PostgREST, events row.
   Nothing here emails or texts anyone yet - who takes a lead is the portal's job
   (claim/lock, Sep 16 plan). This file only makes sure the lead is never lost.
--------------------------------------------------------------------------- */

const LINES = new Set(['towing', 'nemt', 'trucking', 'chat', 'quote']);
const TEXT = ['business', 'contact', 'phone', 'email', 'city', 'branch', 'notes', 'page', 'src', 'lang'];
const CAP = { notes: 2000, page: 200, src: 60, lang: 5 };

const sb = () => {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return { base: base.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
};

/* per-instance: { ip -> [timestamps] } */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 10;
}

const clean = (v, max = 200) => (v == null ? null : String(Array.isArray(v) ? v.join(', ') : v).trim().slice(0, max) || null);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

  /* the honeypot: say yes, write nothing */
  if (clean(b.website)) return res.status(200).json({ ok: true });
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'Too many requests - please call us.' });

  const line = String(b.line || '').toLowerCase();
  if (!LINES.has(line)) return res.status(400).json({ ok: false, error: 'Unknown line' });

  const row = { line, ip: ip || null, ua: clean(req.headers['user-agent'], 300), is_test: b.is_test === true };
  for (const k of TEXT) row[k] = clean(b[k], CAP[k] || 200);
  if (!row.lang) row.lang = 'en';

  /* a lead with nothing to call back is not a lead */
  const digits = String(row.phone || '').replace(/\D/g, '');
  if (digits.length < 10 && !row.email) return res.status(400).json({ ok: false, error: 'A phone number or email is needed' });
  if (!row.contact && !row.business) return res.status(400).json({ ok: false, error: 'A name is needed' });

  /* everything else the page sent, capped, into fields */
  const fields = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'line' || k === 'website' || k === 'is_test' || TEXT.includes(k)) continue;
    if (Object.keys(fields).length >= 40) break;
    fields[String(k).slice(0, 40)] = Array.isArray(v) ? v.slice(0, 20).map(x => String(x).slice(0, 120)) : clean(v, 300);
  }
  row.fields = fields;

  const s = sb();
  if (!s) return res.status(500).json({ ok: false, error: 'Storage not configured' });

  const r = await fetch(`${s.base}/rest/v1/leads`, {
    method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' }, body: JSON.stringify([row]),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j) || !j[0]) {
    return res.status(502).json({ ok: false, error: 'Could not save - please call (951) 695-1500' });
  }
  const id = j[0].id;

  /* the audit row, same shape as sms.js; a failure here must not fail the lead */
  try {
    await fetch(`${s.base}/rest/v1/events`, {
      method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify([{ actor: 'website', kind: 'lead.new', source: 'website', client_no: null,
        payload: { lead_id: id, line, page: row.page, src: row.src, lang: row.lang, city: row.city, is_test: row.is_test } }]),
    });
  } catch { /* see above */ }

  return res.status(200).json({ ok: true, id });
}
