// /api/hawksoft — server-side proxy to the HawkSoft Partner API (v4.0).
// Reads HAWKSOFT_CLIENT_ID + HAWKSOFT_SECRET from Vercel env vars.
//
// GET  → non-PII aggregates (status, scopes, offices, client counts). No auth beyond deploy.
// POST → Test Lab / write actions. REQUIRES header  x-admin-key: <ADMIN_API_KEY env var>.
//        Actions: create_test_client, add_log, lookup_client (returns MASKED field shapes only).

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
    if ((req.headers['x-admin-key'] || '') !== KEY) {
      return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
    }

    const { action } = req.body || {};

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
