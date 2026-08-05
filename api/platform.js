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
const OFFICE_MAP = { '1': 'Moreno Valley', '2': 'Riverside Van Buren', '3': 'Riverside Magnolia', '4': 'Lake Elsinore' };

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

    if (action === 'delta_sync') {
      const out = await runDeltaSync(s, email);
      return res.status(out.ok ? 200 : 502).json({ ...out, email });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET/POST only' });
  const view = String(req.query.view || '');

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
    let path;
    if (q) {
      // Search: client_no exact, OR name/business/phone/email contains (case-insensitive)
      const like = `*${q.replace(/[,()*]/g, '')}*`;
      const ors = [
        `first_name.ilike.${like}`,
        `last_name.ilike.${like}`,
        `business_name.ilike.${like}`,
        `phone.ilike.${like}`,
        `email.ilike.${like}`,
      ];
      if (/^\d+$/.test(q)) ors.unshift(`client_no.eq.${q}`);
      path = `clients?select=*&or=(${ors.join(',')})&order=client_no.asc&limit=100`;
    } else {
      path = 'clients?select=*&order=client_no.asc&limit=100';
    }
    const cl = await sbGet(s, path);
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
  if (view === 'job_status') {
    const job = await getActiveJob(s);
    const last = await sbGet(s, "sync_jobs?order=created_at.desc&limit=1");
    return res.status(200).json({ ok: true, email, job: job || (last.rows || [])[0] || null });
  }

  /* ---- Sync status ---- */
  if (view === 'audit_list') {
    const q = String(req.query.q || '').trim().toLowerCase();
    const AUDIT_CUTOFF = '2026-07-29'; // proof-of-payment process started ~here; older charges are pre-audit
    const tasks = await sbGet(s, 'audit_tasks?select=*&order=created_at.desc&limit=500');
    const atts = await sbGet(s, 'attachments?select=id,client_no,payment_id,kind,doc_type,filename,carrier,amount,created_at,filed_hawksoft&order=created_at.desc&limit=1000');
    const pays = await sbGet(s, 'bridge_ledger?select=*&order=ts.desc&limit=500');
    // client names for the payments (dedupe client ids)
    const ids = [...new Set((pays.rows || []).map(p => p.client_id).filter(x => x != null))];
    const nameMap = {};
    if (ids.length) {
      const cl = await sbGet(s, `clients?client_no=in.(${ids.join(',')})&select=client_no,first_name,last_name,business_name`);
      for (const c of (cl.rows || [])) nameMap[c.client_no] = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
    }
    // record_type per client (to derive service path) — from policies
    const typeMap = {};
    if (ids.length) {
      const po = await sbGet(s, `policies?client_no=in.(${ids.join(',')})&select=client_no,record_type`);
      for (const r of (po.rows || [])) { if (!typeMap[r.client_no]) typeMap[r.client_no] = r.record_type; if (r.record_type === 'dmv_service') typeMap[r.client_no] = 'dmv_service'; }
    }
    const comm = await sbGet(s, 'agent_commission?select=*');
    const commMap = {}; for (const c of (comm.rows || [])) commMap[c.agent_email] = Number(c.percentage);

    let rows = (pays.rows || []).map(p => {
      const dateStr = String(p.ts || '').slice(0, 10);
      const preAudit = dateStr < AUDIT_CUTOFF;
      const purpose = String(p.purpose || '').toLowerCase();
      let path = p.service_path;
      if (!path) {
        if (purpose.includes('dmv') || purpose.includes('registration') || purpose.includes('regist')) path = 'dmv_service';
        else path = typeMap[p.client_id] || 'insurance';
      }
      const docs = (atts.rows || []).filter(a => (a.payment_id === p.id) || (a.client_no === p.client_id));
      const task = (tasks.rows || []).find(t => t.payment_id === p.id);
      const auditStatus = preAudit ? 'pre_audit' : (task ? task.status : (p.audit_status || 'client_paid'));
      const cost = p.service_cost != null ? Number(p.service_cost) : (p.carrier_paid_amount != null ? Number(p.carrier_paid_amount) : null);
      const fee = p.fee_amount != null ? Number(p.fee_amount) : (cost != null ? Number(p.amount) - cost : null);
      const pct = commMap[p.agent] != null ? commMap[p.agent] : 10;
      const commission = (fee != null && auditStatus === 'complete') ? +(fee * pct / 100).toFixed(2) : null;
      return {
        id: p.id, ts: p.ts, client_no: p.client_id, client_name: nameMap[p.client_id] || null,
        amount: Number(p.amount), kind: p.kind, purpose: p.purpose, ref: p.ref,
        agent: p.agent, path, audit_status: auditStatus, pre_audit: preAudit,
        service_cost: cost, fee, pct, commission, doc_count: docs.length, task_id: task ? task.id : null,
      };
    });
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
    return res.status(200).json({ ok: true, email, rows, attachments: atts.rows || [], commissions: comm.rows || [] });
  }

  if (view === 'agent_breakdown') {
    const agent = String(req.query.agent || '');
    const r = await sbGet(s, `bridge_ledger?agent=eq.${encodeURIComponent(agent)}&select=*&order=ts.desc&limit=500`);
    return res.status(200).json({ ok: true, email, rows: r.rows || [] });
  }

  if (view === 'attachment_get') {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const r = await sbGet(s, `attachments?id=eq.${id}&select=filename,mime,file_b64,blob_url`);
    const a = (r.rows || [])[0];
    if (!a) return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(200).json({ ok: true, filename: a.filename, mime: a.mime, file_b64: a.file_b64, blob_url: a.blob_url });
  }

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
