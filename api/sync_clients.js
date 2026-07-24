export const config = { maxDuration: 60 };
// /api/sync_clients — builds the phone -> HawkSoft client index used by /api/screenpop.
//
// HawkSoft's Partner API has NO phone-search endpoint. The documented sync model is:
//   1. GET /clients            -> array of client IDs (optionally changed since ?asOf=)
//   2. POST /clients (<=200)   -> full client objects for those IDs
// So we walk the book once, extract every phone contact, and store it in Supabase.
// After the first full build, nightly incremental runs use asOf and take seconds.
//
// Auth: header x-admin-key: <ADMIN_API_KEY>
// POST body (all optional):
//   { offset: 0, batches: 12, asOf: "2026-07-01T00:00:00Z", reset: false }
// Returns { nextOffset, totalIds, indexed } — call again with nextOffset until done.

const AGENCY_ID = 15112;
const BASE = 'https://integration.hawksoft.app';
const BATCH = 200;

const digits10 = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
};

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const base = url.replace(/\/$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return { base, headers };
}

// Pull every phone contact out of a client object, tolerating v4 shape variations.
function phonesFrom(client) {
  const out = [];
  const people = Array.isArray(client.people) ? client.people : [];
  const push = (value, type, who) => {
    const p = digits10(value);
    if (p) out.push({ phone10: p, contact_type: type || null, who: who || null });
  };
  for (const person of people) {
    const who = [person.firstName, person.lastName].filter(Boolean).join(' ').trim() || null;
    for (const c of (Array.isArray(person.contacts) ? person.contacts : [])) {
      const t = String(c.type || '');
      if (/phone|cell|mobile|fax/i.test(t) && !/fax/i.test(t)) push(c.value, t, who);
    }
  }
  for (const c of (Array.isArray(client.contacts) ? client.contacts : [])) {
    const t = String(c.type || '');
    if (/phone|cell|mobile/i.test(t)) push(c.value, t, null);
  }
  return out;
}

function displayName(client) {
  const p = Array.isArray(client.people) ? client.people[0] : null;
  if (p) {
    const n = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
    if (n) return n;
  }
  return client.businessName || client.name || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const KEY = process.env.ADMIN_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'ADMIN_API_KEY env var not set' });
  if ((req.headers['x-admin-key'] || '') !== KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
  }

  const ID = process.env.HAWKSOFT_CLIENT_ID;
  const SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) return res.status(500).json({ ok: false, error: 'Missing HawkSoft credentials' });
  const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');

  const db = sb();
  if (!db) return res.status(500).json({ ok: false, error: 'SUPABASE env vars missing' });

  const b = req.body || {};
  const offset = Math.max(0, parseInt(b.offset, 10) || 0);
  const batches = Math.min(20, Math.max(1, parseInt(b.batches, 10) || 10));
  const asOf = b.asOf ? String(b.asOf).trim() : '';

  // 1. Get the client-ID list (full book, or changed-since when asOf is supplied).
  const listUrl = `${BASE}/vendor/agency/${AGENCY_ID}/clients?version=4.0`
    + (asOf ? `&asOf=${encodeURIComponent(asOf)}` : '');
  const lr = await fetch(listUrl, { headers: { Authorization: AUTH } });
  const lText = await lr.text();
  if (!lr.ok) return res.status(200).json({ ok: false, step: 'client list', httpStatus: lr.status, detail: lText.slice(0, 300) });
  let ids = [];
  try { ids = JSON.parse(lText); } catch { return res.status(200).json({ ok: false, error: 'Client list was not JSON' }); }
  if (!Array.isArray(ids)) return res.status(200).json({ ok: false, error: 'Unexpected client list shape' });

  // 2. Read clients in batches of 200 and collect phone rows.
  const rows = [];
  let processed = 0;
  let cursor = offset;
  const started = Date.now();

  for (let n = 0; n < batches && cursor < ids.length; n++) {
    if (Date.now() - started > 45000) break; // stay inside the function time budget
    const slice = ids.slice(cursor, cursor + BATCH);
    const cr = await fetch(`${BASE}/vendor/agency/${AGENCY_ID}/clients?version=4.0&include=Details,People,Contacts`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNumbers: slice }),
    });
    const cText = await cr.text();
    if (!cr.ok) return res.status(200).json({ ok: false, step: 'client read', httpStatus: cr.status, detail: cText.slice(0, 300), nextOffset: cursor });
    let clients = [];
    try { clients = JSON.parse(cText); } catch { clients = []; }
    for (const c of (Array.isArray(clients) ? clients : [])) {
      const num = c.clientNumber ?? c.id;
      if (num == null) continue;
      const name = displayName(c);
      for (const p of phonesFrom(c)) {
        rows.push({
          phone10: p.phone10,
          client_number: num,
          display_name: p.who || name,
          office_id: c.officeId ?? null,
          contact_type: p.contact_type,
          updated_at: new Date().toISOString(),
        });
      }
    }
    processed += slice.length;
    cursor += BATCH;
  }

  // 3. Upsert (last write wins on a shared number — acceptable for screen pop).
  let indexed = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const ur = await fetch(`${db.base}/rest/v1/client_phone_index?on_conflict=phone10`, {
      method: 'POST',
      headers: { ...db.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!ur.ok) {
      const t = await ur.text();
      return res.status(200).json({ ok: false, step: 'index write', detail: t.slice(0, 300), nextOffset: cursor });
    }
    indexed += chunk.length;
  }

  const done = cursor >= ids.length;
  if (done) {
    await fetch(`${db.base}/rest/v1/sync_state?on_conflict=key`, {
      method: 'POST',
      headers: { ...db.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ key: 'client_phone_index', last_sync: new Date().toISOString(), note: `${ids.length} client ids`, updated_at: new Date().toISOString() }]),
    });
  }

  return res.status(200).json({
    ok: true, totalIds: ids.length, processedThisCall: processed,
    phonesIndexedThisCall: indexed, nextOffset: done ? null : cursor, done,
  });
}
