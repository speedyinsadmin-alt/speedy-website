// /api/hawksoft — server-side proxy to the HawkSoft Partner API (v4.0).
// Reads HAWKSOFT_CLIENT_ID + HAWKSOFT_SECRET from Vercel env vars.
// The secret never reaches the browser.
//
// SECURITY POLICY (v1): this endpoint returns NON-PII AGGREGATES ONLY —
// connection status, scopes, offices, and client COUNTS. No client names,
// numbers, contacts, or policy data. Do not add client-level endpoints here
// until proper server-side auth is added in front of this function.

const AGENCY_ID = 15112;
const BASE = 'https://integration.hawksoft.app';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const ID = process.env.HAWKSOFT_CLIENT_ID;
  const SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing HAWKSOFT_CLIENT_ID or HAWKSOFT_SECRET env var' });
  }

  const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const out = { ok: true, agencyId: AGENCY_ID, errors: [] };

  const get = async (path) => {
    const r = await fetch(BASE + path, { headers: { Authorization: AUTH } });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`);
    return r.json();
  };

  // 1) Subscription + scopes
  try {
    const agencies = await get('/vendor/agencies?version=4.0');
    const ours = (agencies || []).find(a => a.agencyId === AGENCY_ID);
    out.subscribed = !!ours;
    out.scopes = ours ? ours.scopes : [];
  } catch (e) { out.ok = false; out.errors.push('agencies ' + e.message); }

  // 2) Offices (names + addresses only — office config, not client data)
  try {
    const offices = await get(`/vendor/agency/${AGENCY_ID}/offices?version=4.0`);
    out.offices = (offices || []).map(o => ({
      id: o.officeId,
      name: o.officeDescription || o.subAgencyName || '(unnamed)',
      primary: !!o.primaryOffice,
      address: [o.addressLine1, o.city, o.state, o.zipcode].filter(Boolean).join(', '),
      archived: !!o.archived,
    }));
  } catch (e) { out.errors.push('offices ' + e.message); }

  // 3) Client counts — IDs are fetched server-side and ONLY counts are returned
  const countSince = async (asOf) => {
    const q = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
    const ids = await get(`/vendor/agency/${AGENCY_ID}/clients?version=4.0${q}`);
    return Array.isArray(ids) ? ids.length : 0;
  };
  try {
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const start7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [total, today, week] = await Promise.all([
      countSince(null),
      countSince(startToday),
      countSince(start7d),
    ]);
    out.clients = { total, changedToday: today, changedLast7Days: week };
  } catch (e) { out.errors.push('clients ' + e.message); }

  if (out.errors.length && out.subscribed === undefined) out.ok = false;
  return res.status(200).json(out);
}
