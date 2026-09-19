/* HawkSoft -> platform: the one client mapper, shared (Sep 18).

   Until Sep 18 this code lived in platform.js and only the syncs could run it. A client
   created in HawkSoft today and charged before the next sync showed as "Client #26427"
   on every platform list until the 9 AM run (seen Sep 16 on the document center).
   hawksoft.js now pulls the record the moment it writes a ledger row for a client we do
   not hold - with THIS mapper, so there is one mapping, not two that drift.

   Underscore file: not a Vercel function (same as _inbox.js, _push.js). No secrets here;
   HAWKSOFT_CLIENT_ID / HAWKSOFT_SECRET and the Supabase service key are read from env. */

export const AGENCY_ID = 15112;
export const TEST_CLIENT = 26081; // ZZTEST — the only client sync/HawkSoft-read will touch
export const HS_BASE = 'https://integration.hawksoft.app';
// HawkSoft office ids (NOT RingCentral office groups — see the calls view).
export const OFFICE_MAP = { '1': 'Moreno Valley', '2': 'Riverside Van Buren', '3': 'Riverside Magnolia', '4': 'Lake Elsinore', '5': 'Colton' };

// Carrier name normalization (misspellings / variants -> canonical). Grow as needed.
export const CARRIER_NORMALIZE = {
  'MAPFREE': 'MAPFRE',
  'MAPFRE': 'MAPFRE',
  'MCGRAW INSURANCE SERVICES': 'MCGRAW',
  'MCGRAW': 'MCGRAW',
};
export function normalizeCarrier(name) {
  if (!name) return null;
  const key = String(name).trim().toUpperCase();
  return CARRIER_NORMALIZE[key] || String(name).trim();
}
// Classify a HawkSoft "policy" container into what it really is.
// Returns { record_type, renewal_months, carrier } — carrier cleared for non-insurance.
export function classifyRecord(rawCarrier) {
  const c = String(rawCarrier || '').toUpperCase();
  if (c.includes('DEPARTMENT OF MOTOR VEHICLES') || /\bDMV\b/.test(c)) {
    return { record_type: 'dmv_service', renewal_months: 12, carrier: null };
  }
  if (rawCarrier && rawCarrier.trim()) {
    return { record_type: 'insurance', renewal_months: null, carrier: normalizeCarrier(rawCarrier) };
  }
  return { record_type: 'unknown', renewal_months: null, carrier: null };
}

/* ---------- Supabase, service role ---------- */
export function sbEnv() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}
export async function sbUpsert(s, table, rows, conflict) {
  const r = await fetch(`${s.base}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: 'POST',
    headers: { ...s.hdrs, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

/* ---------- HawkSoft, Partner API v4 ---------- */
export function hsAuth() {
  const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) return null;
  return 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
}
export async function hsCall(path, opts = {}) {
  const AUTH = hsAuth();
  if (!AUTH) return { error: 'HawkSoft env vars missing' };
  const r = await fetch(HS_BASE + path, { ...opts, headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body };
}
export const hsFetchClient = (no = TEST_CLIENT, opts = {}) => hsCall(`/vendor/agency/${AGENCY_ID}/client/${no}?version=4.0&include=Details,People,Contacts,Policies,Invoices`, opts);
export const hsAllClientIds = () => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&asOf=2000-01-01T00:00:00Z`);
export const hsChangedSince = (iso) => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&asOf=${encodeURIComponent(iso)}`);
export const hsClientBatch = (ids) => hsCall(`/vendor/agency/${AGENCY_ID}/clients?version=4.0&include=Details,People,Contacts,Policies`, { method: 'POST', body: JSON.stringify({ clientNumbers: ids }) });

export const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return null; };
export const dateOnly = v => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; };

/* ============ Shared: map + upsert one HawkSoft client object ============ */
export async function upsertHsClient(s, c) {
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

/* ---------- FIRST-CHARGE SYNC (Sep 18) ----------
   Called by hawksoft.js after a ledger row lands for a client (and right after it creates
   one from the charge page). If our clients table has no row for the number, the record
   is pulled from HawkSoft and mapped by upsertHsClient - the same rows the syncs write.
   A row we already hold is left alone; the delta sync keeps it current.

   Fail-soft and bounded: the money is recorded before this runs, a HawkSoft hiccup must
   never turn a charge into an error, and anything missed here is caught by the next
   sync. Every read carries a timeout so a slow HawkSoft cannot hold the charge. */
export async function ensureClientSynced(s, clientNo, opts = {}) {
  const cn = parseInt(clientNo, 10);
  if (!s) return { ok: false, skipped: 'no supabase' };
  if (!isFinite(cn) || cn <= 0) return { ok: false, skipped: 'no client' };
  const ms = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  try {
    const have = await fetch(`${s.base}/rest/v1/clients?client_no=eq.${cn}&select=client_no`, { headers: s.hdrs, signal: AbortSignal.timeout(ms) });
    if (!have.ok) return { ok: false, error: 'clients read HTTP ' + have.status };
    const rows = await have.json().catch(() => null);
    if (!Array.isArray(rows)) return { ok: false, error: 'clients read unreadable' };
    if (rows.length) return { ok: true, existed: true, client_no: cn };
    const fresh = await hsFetchClient(cn, { signal: AbortSignal.timeout(ms) });
    if (fresh.error || fresh.status !== 200 || !fresh.body || typeof fresh.body !== 'object') return { ok: false, error: fresh.error || ('HawkSoft HTTP ' + fresh.status) };
    const up = await upsertHsClient(s, fresh.body);
    if (!up.ok) return { ok: false, error: up.error || 'upsert failed' };
    /* the evidence, on the client's own log; kind sync.* so the recent-clients list
       keeps showing the charge, not this */
    await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(ms),
      body: JSON.stringify([{ actor: opts.actor || 'system:first_charge', kind: 'sync.first_charge', client_no: cn, source: 'hawksoft_sync', payload: { policies_synced: up.policies, reason: opts.reason || null } }]) }).catch(() => null);
    return { ok: true, existed: false, client_no: cn, policies: up.policies };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 160) }; }
}
