export const config = { maxDuration: 30 };
// /api/platform — backend for the Platform Console (admin/platform.html).
// ACCESS: Google ID token (header x-id-token), allowlist below.
// GET  = reads (HawkSoft ZZTEST, our clients/policies/events, ledger, tables)
// POST = sync_zztest only: HawkSoft client 26081 -> our clients/policies + events. No other writes.

const GOOGLE_CLIENT_ID = '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const ALLOWLIST = ['info@speedyins.com'];
const AGENCY_ID = 15112;
const TEST_CLIENT = 26081; // ZZTEST — the only client sync/HawkSoft-read will touch
const HS_BASE = 'https://integration.hawksoft.app';

async function verifyGoogle(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (r.status !== 200) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    return ALLOWLIST.includes(email) ? email : null;
  } catch { return null; }
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
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

async function hsFetchClient() {
  const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) return { error: 'HawkSoft env vars missing' };
  const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const r = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${TEST_CLIENT}?version=4.0&include=Details,People,Contacts,Policies,Invoices`, {
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}

const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
const dateOnly = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const email = await verifyGoogle(req.headers['x-id-token']);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authorized' });

  /* ============ POST: sync ZZTEST from HawkSoft into our tables ============ */
  if (req.method === 'POST') {
    let action = ''; try { action = (req.body && req.body.action) || ''; } catch {}
    if (action !== 'sync_zztest') return res.status(400).json({ ok: false, error: 'Unknown action' });
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });

    const hs = await hsFetchClient();
    if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status) });
    const c = hs.body || {};
    const people = c.people || c.People || [];
    const p0 = people[0] || {};
    const details = c.details || c.Details || {};

    const clientRow = {
      client_no: TEST_CLIENT,
      kind: p0.businessName ? 'business' : 'person',
      first_name: pick(p0, 'firstName', 'FirstName'),
      last_name: pick(p0, 'lastName', 'LastName'),
      business_name: pick(p0, 'businessName', 'BusinessName') || pick(c, 'businessName', 'name'),
      email: pick(p0, 'email', 'Email'),
      phone: pick(p0, 'phone', 'cellPhone', 'homePhone'),
      address1: pick(details, 'address1', 'Address1') || pick(c, 'address1'),
      city: pick(details, 'city', 'City') || pick(c, 'city'),
      state: pick(details, 'state', 'State') || pick(c, 'state'),
      zip: pick(details, 'zip', 'Zip', 'postalCode') || pick(c, 'zip'),
      branch: pick(details, 'officeName', 'office') || pick(c, 'officeName', 'office'),
      status: pick(details, 'status') || pick(c, 'status') || 'Active',
      extras: { hawksoft_snapshot_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    };
    const up1 = await sbUpsert(s, 'clients', [clientRow], 'client_no');
    if (!up1.ok) return res.status(500).json({ ok: false, error: 'clients upsert failed', detail: up1.body });
    const ourClient = up1.body && up1.body[0];

    const hsPols = c.policies || c.Policies || [];
    let polCount = 0;
    for (const p of hsPols) {
      const guid = pick(p, 'id', 'policyId', 'guid', 'Id', 'PolicyId');
      const row = {
        client_id: ourClient.id,
        client_no: TEST_CLIENT,
        hs_policy_guid: guid ? String(guid) : null,
        policy_number: pick(p, 'policyNumber', 'number', 'PolicyNumber'),
        lob: pick(p, 'lob', 'lineOfBusiness', 'LOB'),
        carrier: pick(p, 'carrier', 'carrierName', 'company', 'Carrier'),
        effective_date: dateOnly(pick(p, 'effectiveDate', 'EffectiveDate')),
        expiration_date: dateOnly(pick(p, 'expirationDate', 'ExpirationDate')),
        premium: Number(pick(p, 'premium', 'Premium')) || null,
        status: pick(p, 'status', 'Status') || 'Active',
        billing: pick(p, 'billing', 'billType', 'BillingType'),
        carrier_extras: p,  // full HawkSoft policy object preserved verbatim
        updated_at: new Date().toISOString(),
      };
      const up = await sbUpsert(s, 'policies', [row], 'hs_policy_guid');
      if (up.ok) polCount++;
    }

    await sbInsert(s, 'events', [{
      actor: email, kind: 'client.synced', client_no: TEST_CLIENT, source: 'hawksoft_sync',
      payload: { policies_synced: polCount, hs_status: hs.status },
    }]);

    return res.status(200).json({ ok: true, email, synced: { client_no: TEST_CLIENT, policies: polCount } });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  const view = String(req.query.view || '');

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
    const cl = await sbGet(s, 'clients?select=*&order=client_no.asc&limit=200');
    const po = await sbGet(s, 'policies?select=client_no,status');
    const counts = {};
    for (const p of (po.rows || [])) {
      counts[p.client_no] = counts[p.client_no] || { total: 0, active: 0 };
      counts[p.client_no].total++;
      if (String(p.status).toLowerCase() === 'active') counts[p.client_no].active++;
    }
    return res.status(200).json({ ok: cl.ok, email, clients: cl.rows, policy_counts: counts });
  }

  /* ---- Our single client: profile + policies + payments + events ---- */
  if (view === 'our_client') {
    const no = parseInt(String(req.query.no || ''), 10);
    if (!isFinite(no)) return res.status(400).json({ ok: false, error: 'no= required' });
    const [cl, po, led, ev] = await Promise.all([
      sbGet(s, `clients?client_no=eq.${no}&select=*`),
      sbGet(s, `policies?client_no=eq.${no}&select=*&order=effective_date.desc`),
      sbGet(s, `bridge_ledger?client_id=eq.${no}&select=*&order=ts.desc&limit=50`),
      sbGet(s, `events?client_no=eq.${no}&select=*&order=ts.desc&limit=50`),
    ]);
    return res.status(200).json({ ok: true, email, client: (cl.rows || [])[0] || null, policies: po.rows || [], payments: led.rows || [], events: ev.rows || [] });
  }

  /* ---- Ledger ---- */
  if (view === 'ledger') {
    const r = await sbGet(s, 'bridge_ledger?select=*&order=ts.desc&limit=50');
    return res.status(200).json({ ok: r.ok, email, rows: r.rows || [] });
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
