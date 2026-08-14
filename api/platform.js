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
};
const AGENT_NAME = {
  'sammy@speedyins.com':'Sammy Rodriguez','jesus@speedyins.com':'Jesus Velarde','info@speedyins.com':'Tony Dabouqi',
  'alejandra@speedyins.com':'Alejandra Salas','yasmin@speedyins.com':'Yasmin Alfaro','lfigueroa@speedyins.com':'Laura Figueroa',
  'jorge@speedyins.com':'Jorge Ramos','chris@speedyins.com':'Christian Aguilar','yolanda@speedyins.com':'Yolanda Hernandez',
  'fernando@speedyins.com':'Fernando Salgado','esmeralda@speedyins.com':'Esmeralda Ayala','irene@speedyins.com':'Irene Ayala',
  'tony@speedyins.com':'Tony Dabouqi','lana@speedyins.com':'Lana D',
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

const owns = (row, email) => (row.commission_to || agentEmailOf(row.agent)) === email;
// Agents can sign into the PORTAL and see ONLY their own data (never admin views, never other agents).
const AGENT_ALLOWLIST = [
  'sammy@speedyins.com', 'yolanda@speedyins.com', 'jorge@speedyins.com', 'lfigueroa@speedyins.com',
  'chris@speedyins.com', 'yasmin@speedyins.com', 'fernando@speedyins.com', 'jesus@speedyins.com',
  'alejandra@speedyins.com', 'esmeralda@speedyins.com', 'irene@speedyins.com',
  'tony@speedyins.com', 'lana@speedyins.com',
];
const ALLOWLIST = ADMIN_ALLOWLIST; // back-compat for existing admin checks
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
    return ADMIN_ALLOWLIST.includes(email) ? email : null;
  } catch { return null; }
}

// Verify for portal access: returns { email, role } where role is 'admin' or 'agent'.
async function verifyPortal(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (r.status !== 200) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    if (ADMIN_ALLOWLIST.includes(email)) return { email, role: 'admin' };
    if (AGENT_ALLOWLIST.includes(email)) return { email, role: 'agent' };
    return null;
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

  let clients = 0, pols = 0, done = 0;
  const began = Date.now();
  const BUDGET_MS = 240000;   // stop well inside the function limit and report progress
  let ranOut = false;
  for (let i = 0; i < ids.length; i += 25) {
    if (Date.now() - began > BUDGET_MS) { ranOut = true; break; }
    const batch = ids.slice(i, i + 25);
    const b = await hsClientBatch(batch);
    done = i + batch.length;
    if (b.error || b.status !== 200) continue;
    for (const c of (Array.isArray(b.body) ? b.body : [])) {
      const r = await upsertHsClient(s, c);
      if (r.ok) { clients++; pols += r.policies; }
    }
  }

  // Only advance the watermark when the whole window was processed. If we ran out of
  // time, leave it where it was so the next press picks up the same window and keeps
  // going — a four-day gap is caught up by pressing the button a few times.
  if (!ranOut) {
    await fetch(`${s.base}/rest/v1/sync_state?key=eq.hawksoft_clients`, {
      method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_sync: startedAt, last_count: clients, note: 'delta sync', updated_at: startedAt }),
    });
  }
  await sbInsert(s, 'events', [{ actor, kind: 'sync.completed', source: 'hawksoft_sync',
    payload: { changed_ids: ids.length, clients_updated: clients, policies_updated: pols, as_of: asOf } }]);
  return { ok: true, changed: ids.length, clients, policies: pols, as_of: asOf, partial: ranOut, processed: done };
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

  // ============ PORTAL views (agents + admin, scoped to the signed-in agent) ============
  // These run BEFORE the admin gate so agents can reach them; each is strictly scoped to the caller's own email.
  const view = String(req.query.view || '');
  const portalViews = ['portal_home', 'portal_search', 'portal_client', 'portal_thumbs', 'portal_doc', 'portal_staff', 'portal_news', 'portal_share_due'];
  if (portalViews.includes(view)) {
    const who = await verifyPortal(req.headers['x-id-token']);
    if (!who) return res.status(401).json({ ok: false, error: 'Not authorized' });
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });

    if (view === 'portal_search') {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(200).json({ ok: true, results: [] });
      const like = `*${q.replace(/[,()*]/g, '')}*`;
      const ors = [
        `first_name.ilike.${like}`, `last_name.ilike.${like}`, `business_name.ilike.${like}`,
        `phone.ilike.${like}`, `email.ilike.${like}`,
      ];
      if (/^\d+$/.test(q)) ors.unshift(`client_no.eq.${q}`);
      const cl = await sbGet(s, `clients?select=client_no,first_name,last_name,business_name,phone,branch&or=(${ors.join(',')})&order=client_no.asc&limit=25`);
      const results = (cl.rows || []).map(c => ({
        client_no: c.client_no,
        name: c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' '),
        phone: c.phone || null, branch: c.branch || null,
      }));
      return res.status(200).json({ ok: true, results });
    }

    if (view === 'portal_staff') {
      // agent list for the "commission to" picker — no HawkSoft dependency
      return res.status(200).json({ ok: true,
        staff: Object.entries(AGENT_NAME).map(([email, name]) => ({ email, name })),
        producers: PRODUCER_MAP });
    }

if (view === 'portal_share_due') {
      /* Completed audits where this agent owns the commission, somebody else ran the
         charge, and no share decision has been made. Asked at completion because that
         is the first moment the fee — and so the commission — is a real number. */
      const r = await sbGet(s, `bridge_ledger?commission_to=eq.${encodeURIComponent(me)}`
        + `&audit_status=eq.complete&share_locked_at=is.null&is_test=is.false`
        + `&select=id,ts,client_id,amount,agent,fee_amount&order=ts.desc&limit=10`);
      const rate = await sbGet(s, `agent_commission?agent_email=eq.${encodeURIComponent(me)}&select=percentage`);
      const pct = (rate.rows && rate.rows[0]) ? Number(rate.rows[0].percentage) : 10;
      const due = (r.rows || [])
        .filter(x => agentEmailOf(x.agent) && agentEmailOf(x.agent) !== me && x.fee_amount != null)
        .map(x => ({ id: x.id, ts: x.ts, client_no: x.client_id, amount: Number(x.amount),
          fee: Number(x.fee_amount), commission: +(Number(x.fee_amount) * pct / 100).toFixed(2),
          helper_email: agentEmailOf(x.agent),
          helper_name: AGENT_NAME[agentEmailOf(x.agent)] || agentEmailOf(x.agent) }));
      return res.status(200).json({ ok: true, rate: pct, due });
    }

    if (view === 'portal_news') {
      /* Notifications, built from the events we already write. Nothing new is stored
         except a "last seen" marker per agent, so this stays cheap. */
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const ev = await sbGet(s, `events?ts=gte.${since}`
        + `&kind=in.(commission.reassigned,commission.shared,audit.repaired,client.corrected,client.correction_rejected)`
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
      // One document's bytes, on demand.
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const r = await sbGet(s, `attachments?id=eq.${encodeURIComponent(id)}&select=filename,mime,file_b64,blob_url`);
      const row = (r.rows || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      return res.status(200).json({ ok: true, ...row });
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
      const pay = await sbGet(s, `bridge_ledger?client_id=eq.${no}&is_test=is.false&select=id,ts,amount,purpose,audit_status,kind,ref,agent,fee_amount,service_cost,carrier_name,commission_to,producer_code&order=ts.desc&limit=50`);
      const docs = await sbGet(s, `attachments?client_no=eq.${no}&select=id,payment_id,kind,doc_type,filename,bytes,mime,created_at,filed_hawksoft&order=created_at.desc&limit=200`);
      return res.status(200).json({
        ok: true, client, policies: po.rows || [],
        recent: (pay.rows || []).slice(0, 6),
        payments: (pay.rows || []).map(r => ({
          id: r.id, ts: r.ts, amount: r.amount, purpose: r.purpose, audit_status: r.audit_status,
          kind: r.kind, ref: r.ref,
          charged_by: AGENT_NAME[agentEmailOf(r.agent)] || agentEmailOf(r.agent) || null,
          commission_to: r.commission_to || agentEmailOf(r.agent) || null,
          commission_to_name: AGENT_NAME[r.commission_to || agentEmailOf(r.agent)] || null,
          carrier_name: r.carrier_name, service_cost: r.service_cost, fee_amount: r.fee_amount,
          // NOTE: no commission figures here — the client log is shared with every agent
        })),
        producer_code: client && client.extras ? (client.extras.producer || null) : null,
        producer_name: client && client.extras ? (AGENT_NAME[PRODUCER_MAP[client.extras.producer]] || null) : null,
        documents: docs.rows || [],
      });
    }

    if (view === 'portal_home') {
      const me = who.email;
      // Pull this agent's own ledger rows (match any agent string containing their email)
      const all = await sbGet(s, 'bridge_ledger?is_test=is.false&select=id,ts,client_id,amount,purpose,agent,audit_status,fee_amount,service_cost,txn_id,kind,extra,commission_to,helper_email,helper_share_pct,correction_status&order=ts.desc&limit=500');
      const AUDIT_CUTOFF = '2026-07-29';
      const rate = await sbGet(s, `agent_commission?agent_email=eq.${encodeURIComponent(me)}&select=percentage`);
      const pct = (rate.rows && rate.rows[0]) ? Number(rate.rows[0].percentage) : 10;

      const mine = (all.rows || []).filter(r => owns(r, me) || String(r.agent || '').toLowerCase().includes(me));
      // month boundary (America/Los_Angeles approx via UTC month is fine for display)
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

      const NON_PAYMENT = ['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'];
      let earned = 0, pending = 0, unfinished = [];
      for (const r of mine) {
        const dateStr = String(r.ts || '').slice(0, 10);
        if (dateStr < AUDIT_CUTOFF) continue; // pre-audit: no commission expected
        // no money received => never ask an agent for proof, never count commission
        if (NON_PAYMENT.includes(r.audit_status)) continue;
        if (r.correction_status === 'pending') continue;  // waiting on Tony — nobody should work it
        if (/declin|fail|void|refund/i.test(String(r.kind || ''))) continue;
        const fee = r.fee_amount != null ? Number(r.fee_amount)
          : (r.service_cost != null ? Number(r.amount) - Number(r.service_cost) : null);
        const isOwner = owns(r, me);
        const complete = r.audit_status === 'complete';
        if (complete && fee != null) {
          // only the commission owner earns; a helper who ran the charge earns nothing
          // unless the owner shared, which is applied below
          if (isOwner && r.ts >= monthStart) {
            const share = Number(r.helper_share_pct || 0);
            earned += fee * pct / 100 * (1 - share / 100);
          }
          if (!isOwner && r.helper_email === me && r.ts >= monthStart) {
            earned += fee * pct / 100 * Number(r.helper_share_pct || 0) / 100;
          }
        } else if (r.kind !== 'charge_captured' || r.audit_status) {
          // needs proof of payment / audit
          const feeGuess = fee != null ? fee * pct / 100 : null;
          if (isOwner && r.ts >= monthStart && feeGuess != null) pending += feeGuess;
          unfinished.push({ id: r.id, ts: r.ts, client_no: r.client_id, amount: Number(r.amount),
            purpose: r.purpose, audit_status: r.audit_status || 'client_paid',
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
        unfinished_count: unfinished.length, unfinished,
        recent: mine.slice(0, 10).map(r => ({ ts: r.ts, client_no: r.client_id, amount: Number(r.amount), purpose: r.purpose, audit_status: r.audit_status || 'client_paid' })),
      });
    }
  }

  // Agent-reachable POST actions (each enforces its own scoping below)
  const AGENT_ACTIONS = ['reassign_commission', 'news_seen', 'set_share', 'move_client'];
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
    const atts = await sbGet(s, 'attachments?select=id,client_no,payment_id,kind,doc_type,filename,carrier,amount,created_at,filed_hawksoft,bytes,mime&order=created_at.desc&limit=1000');
    const pays = await sbGet(s, 'bridge_ledger?is_test=is.false&select=*&order=ts.desc&limit=500');
    // client names for the payments (dedupe client ids)
    const ids = [...new Set((pays.rows || []).map(p => p.client_id).filter(x => x != null))];
    const nameMap = {};
    if (ids.length) {
      const cl = await sbGet(s, `clients?client_no=in.(${ids.join(',')})&select=client_no,first_name,last_name,business_name`);
      for (const c of (cl.rows || [])) nameMap[c.client_no] = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
    }
    // record_type per client — track whether client has ANY insurance and ANY dmv (a client can have both)
    const typeMap = {};
    if (ids.length) {
      const po = await sbGet(s, `policies?client_no=in.(${ids.join(',')})&select=client_no,record_type`);
      for (const r of (po.rows || [])) {
        if (!typeMap[r.client_no]) typeMap[r.client_no] = { insurance: false, dmv: false };
        if (r.record_type === 'dmv_service') typeMap[r.client_no].dmv = true;
        else typeMap[r.client_no].insurance = true;
      }
    }
    const comm = await sbGet(s, 'agent_commission?select=*');
    const commMap = {}; for (const c of (comm.rows || [])) commMap[c.agent_email] = Number(c.percentage);

    const NON_PAYMENT_STATUS = ['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'];
    let rows = (pays.rows || [])
      .filter(p => p.correction_status !== 'pending')
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
      const task = (tasks.rows || []).find(t => t.payment_id === p.id);
      const auditStatus = preAudit ? 'pre_audit' : (task ? task.status : (p.audit_status || 'client_paid'));
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
        client_name: nameMap[p.client_id] || (p.extra && p.extra.clientName) || null,
        amount: Number(p.amount), kind: p.kind, purpose: p.purpose, ref: p.ref,
        agent: agentEmail, agent_raw: p.agent, is_admin: isAdmin, secure_link: isSecureLink,
        path, audit_status: auditStatus, pre_audit: preAudit,
        commission_to: p.commission_to || agentEmailOf(p.agent) || null,
        helper_email: p.helper_email || null,
        helper_share_pct: p.helper_share_pct != null ? Number(p.helper_share_pct) : null,
        share_locked_at: p.share_locked_at || null,
        receipt_pending: (p.kind === 'charge_captured') || !!(p.extra && p.extra.receipt_pending === true),
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

  if (view === 'attachment_get') {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    const r = await sbGet(s, `attachments?id=eq.${id}&select=filename,mime,file_b64,blob_url`);
    const a = (r.rows || [])[0];
    if (!a) return res.status(404).json({ ok: false, error: 'not found' });
    return res.status(200).json({ ok: true, filename: a.filename, mime: a.mime, file_b64: a.file_b64, blob_url: a.blob_url });
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
    const [led, att] = await Promise.all([
      sbGet(s, 'bridge_ledger?is_test=is.false&select=id,ts,client_id,amount,kind,audit_status,txn_id,carrier_name,service_cost,fee_amount,commission_to,agent&order=ts.desc&limit=1000'),
      sbGet(s, 'attachments?select=id,client_no,payment_id,kind,doc_type,filename,created_at&order=created_at.desc&limit=1000'),
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
      rows.filter(r => ['client_paid','carrier_pending'].includes(r.audit_status)
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
      rows.filter(r => !r.commission_to && ['client_paid','carrier_pending','complete'].includes(r.audit_status)).map(brief));

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

    const worst = issues.some(i => i.sev === 'high') ? 'attention' : issues.length ? 'minor' : 'clean';
    return res.status(200).json({ ok: true, status: worst, checked: rows.length,
      documents: docs.length, checked_at: new Date().toISOString(), issues });
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

