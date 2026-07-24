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
  const people = c.people || c.People || [];
  const p0 = people[0] || {};
  const details = c.details || c.Details || {};
  const clientRow = {
    client_no: cn,
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
  if (!up1.ok) return { ok: false, error: 'clients upsert failed', detail: up1.body };
  const ourClient = up1.body && up1.body[0];
  const hsPols = c.policies || c.Policies || [];
  let polCount = 0;
  for (const p of hsPols) {
    const guid = pick(p, 'id', 'policyId', 'guid', 'Id', 'PolicyId');
    const row = {
      client_id: ourClient.id,
      client_no: cn,
      hs_policy_guid: guid ? String(guid) : null,
      policy_number: pick(p, 'policyNumber', 'number', 'PolicyNumber'),
      lob: pick(p, 'lob', 'lineOfBusiness', 'LOB'),
      carrier: pick(p, 'carrier', 'carrierName', 'company', 'Carrier'),
      effective_date: dateOnly(pick(p, 'effectiveDate', 'EffectiveDate')),
      expiration_date: dateOnly(pick(p, 'expirationDate', 'ExpirationDate')),
      premium: Number(pick(p, 'premium', 'Premium')) || null,
      status: pick(p, 'status', 'Status') || 'Active',
      billing: pick(p, 'billing', 'billType', 'BillingType'),
      carrier_extras: p,
      updated_at: new Date().toISOString(),
    };
    const up = await sbUpsert(s, 'policies', [row], 'hs_policy_guid');
    if (up.ok) polCount++;
  }
  return { ok: true, client_no: cn, policies: polCount };
}


async function runDeltaSync(s, actor) {
  const st = await sbGet(s, 'sync_state?key=eq.hawksoft_clients&select=*');
  const last = (st.rows && st.rows[0] && st.rows[0].last_sync) || '2026-07-23T00:00:00Z';
  // 30-min safety overlap so nothing slips between runs
  const asOf = new Date(new Date(last).getTime() - 30 * 60 * 1000).toISOString();
  const startedAt = new Date().toISOString();

  const hs = await hsChangedSince(asOf);
  if (hs.error || hs.status !== 200) return { ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status) };
  const ids = Array.isArray(hs.body) ? hs.body.map(Number).filter(isFinite) : [];

  let clients = 0, pols = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25);
    const b = await hsClientBatch(batch);
    if (b.error || b.status !== 200) continue;
    for (const c of (Array.isArray(b.body) ? b.body : [])) {
      const r = await upsertHsClient(s, c);
      if (r.ok) { clients++; pols += r.policies; }
    }
  }

  await fetch(`${s.base}/rest/v1/sync_state?key=eq.hawksoft_clients`, {
    method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
    body: JSON.stringify({ last_sync: startedAt, last_count: clients, note: 'delta sync', updated_at: startedAt }),
  });
  await sbInsert(s, 'events', [{ actor, kind: 'sync.completed', source: 'hawksoft_sync',
    payload: { changed_ids: ids.length, clients_updated: clients, policies_updated: pols, as_of: asOf } }]);
  return { ok: true, changed: ids.length, clients, policies: pols, as_of: asOf };
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
    const out = await runDeltaSync(s, 'system:cron');
    return res.status(out.ok ? 200 : 502).json(out);
  }

  const email = await verifyGoogle(req.headers['x-id-token']);
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
      const hs = await hsAllClientIds();
      if (hs.error || hs.status !== 200) return res.status(502).json({ ok: false, error: hs.error || ('HawkSoft HTTP ' + hs.status), detail: hs.body });
      const ids = Array.isArray(hs.body) ? hs.body.map(Number).filter(isFinite) : [];
      // Resume: subtract client_nos already in our database (paged reads, PostgREST caps at 1000/page)
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

    if (action === 'delta_sync') {
      const out = await runDeltaSync(s, email);
      return res.status(out.ok ? 200 : 502).json({ ...out, email });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
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
    // LIVE: pull this client fresh from HawkSoft before rendering
    let live = false;
    const fresh = await hsFetchClient(no);
    if (!fresh.error && fresh.status === 200 && fresh.body) {
      const up = await upsertHsClient(s, fresh.body);
      live = !!up.ok;
    }
    const [cl, po, led, ev] = await Promise.all([
      sbGet(s, `clients?client_no=eq.${no}&select=*`),
      sbGet(s, `policies?client_no=eq.${no}&select=*&order=effective_date.desc`),
      sbGet(s, `bridge_ledger?client_id=eq.${no}&select=*&order=ts.desc&limit=50`),
      sbGet(s, `events?client_no=eq.${no}&select=*&order=ts.desc&limit=50`),
    ]);
    return res.status(200).json({ ok: true, email, live, refreshed_at: new Date().toISOString(), client: (cl.rows || [])[0] || null, policies: po.rows || [], payments: led.rows || [], events: ev.rows || [] });
  }

  /* ---- Sync status ---- */
  if (view === 'sync_status') {
    const st = await sbGet(s, 'sync_state?key=eq.hawksoft_clients&select=*');
    const ev = await sbGet(s, "events?kind=eq.sync.completed&select=ts,payload&order=ts.desc&limit=5");
    return res.status(200).json({ ok: true, email, state: (st.rows || [])[0] || null, recent: ev.rows || [] });
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
