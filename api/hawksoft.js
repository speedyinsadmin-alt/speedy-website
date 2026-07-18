// /api/hawksoft — server-side proxy to the HawkSoft Partner API (v4.0).
// Reads HAWKSOFT_CLIENT_ID + HAWKSOFT_SECRET from Vercel env vars.
//
// GET  → non-PII aggregates (status, scopes, offices, client counts). No auth beyond deploy.
// POST → Test Lab / write actions. REQUIRES header  x-admin-key: <ADMIN_API_KEY env var>.
//        Actions: create_test_client, add_log, lookup_client (returns MASKED field shapes only).

const AGENCY_ID = 15112;
const BASE = 'https://integration.hawksoft.app';

// Map human LOB names to HawkSoft LOB codes (v4 spec enumeration).
const HS_LOB_CODES = new Set(['ACCT','AGENT','AGLIA','AGPP','AGPR','ANUTY','APKGE','ARCH','AUTOB','AUTOP','BANDM','BLDRK','BMSBP','BOAT','BOP','BOPGL','BOPPR','CFIRE','CGL','COMAR','CONTR','CPKGE','CPL','CRIM','CROP','CUMBR','CYBER','CYCLE','DFIRE','DO','EDP','ELIAB','EO','EPLI','EQ','EQLIA','FIDUC','FINAR','FLOOD','FRBD','GARAG','GLASS','HEALTH','HOME','INMRC','INMRP','INTER','KIDRA','LAW','LIFE','LL','LMORT','MEDIA','MHOME','MMAL','MOPRO','MPL','MTRCR','MTRTK','OCMRC','OPCAR','OTHER','PHYS','PL','PLMSC','PPKGE','PROP','PUMBR','RECV','RRPRL','SCHPR','SFRNC','SIGNS','SMP','SURE','TRANS','TRKRS','ULIFE','VALP','WIND','WORK','WORKV','YACHT','RTRMT','SUPPL','GPMED','GPDEN','GPVIS','GPLIF','GPACC','GPDIS','GPCRI','GPOTH']);
function mapLob(input) {
  const raw = String(input || '').trim();
  const up = raw.toUpperCase();
  if (HS_LOB_CODES.has(up)) return up;
  const s = up.replace(/[^A-Z ]/g, ' ');
  if (/PERSONAL AUTO|PRIVATE PASSENGER|(^| )AUTO( |$)|PPA/.test(s)) return 'AUTOP';
  if (/COMMERCIAL AUTO|BUSINESS AUTO/.test(s)) return 'AUTOB';
  if (/HOMEOWNER|(^| )HOME( |$)|HO\d/.test(s)) return 'HOME';
  if (/RENTER/.test(s)) return 'HOME';
  if (/MOBILE HOME|MANUFACTURED/.test(s)) return 'MHOME';
  if (/DWELLING|FIRE POLICY|LANDLORD/.test(s)) return 'DFIRE';
  if (/MOTORCYCLE|MOTOR CYCLE/.test(s)) return 'CYCLE';
  if (/(^| )RV( |$)|RECREATIONAL/.test(s)) return 'RECV';
  if (/BOAT|WATERCRAFT/.test(s)) return 'BOAT';
  if (/PERSONAL UMBRELLA/.test(s)) return 'PUMBR';
  if (/COMMERCIAL UMBRELLA/.test(s)) return 'CUMBR';
  if (/UMBRELLA/.test(s)) return 'PUMBR';
  if (/FLOOD/.test(s)) return 'FLOOD';
  if (/EARTHQUAKE/.test(s)) return 'EQ';
  if (/GENERAL LIABILITY|(^| )GL( |$)/.test(s)) return 'CGL';
  if (/BUSINESS OWNER|(^| )BOP( |$)/.test(s)) return 'BOP';
  if (/WORKERS? COMP/.test(s)) return 'WORK';
  if (/COMMERCIAL PROPERTY/.test(s)) return 'PROP';
  if (/COMMERCIAL PACKAGE/.test(s)) return 'CPKGE';
  if (/LIFE/.test(s)) return 'LIFE';
  if (/HEALTH|MEDICAL/.test(s)) return 'HEALTH';
  return 'OTHER';
}

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

    /* ---------- Charge page: real-name lookup (minimal fields, no policy/PII dump) ---------- */
    if (action === 'charge_lookup') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}?version=4.0&include=Details,People,Contacts`, {});
      if (r.status !== 200) return res.status(200).json({ ok: false, httpStatus: r.status, error: 'Client not found' });
      const b = r.body || {};
      // Defensive extraction — v4 shapes vary
      let name = '';
      const people = b.people || b.People || [];
      if (people.length) {
        const p = people[0] || {};
        name = [p.businessName, [p.firstName, p.lastName].filter(Boolean).join(' ')].filter(Boolean)[0] || '';
      }
      if (!name) name = b.businessName || b.name || '';
      const raw = JSON.stringify(b);
      const phones = [...new Set((raw.match(/\(\d{3}\)\s?\d{3}-\d{4}/g) || []))].slice(0, 3);
      const officeId = b.officeId || (b.details && b.details.officeId) || b.OfficeId || null;
      const status = b.status || (b.details && b.details.status) || '';
      return res.status(200).json({ ok: true, result: {
        clientNumber: b.clientNumber || clientId, name: name || '(no name on file)',
        phones, officeId, status,
      }});
    }

    /* ---------- Charge page: test write — restricted to ZZTEST #26081 in this phase ---------- */
    if (action === 'charge_log') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (clientId !== 26081) {
        return res.status(400).json({ ok: false, error: 'Charge-page test writes are limited to ZZTEST client #26081 in this phase.' });
      }
      const { amount, purpose, agent } = req.body || {};
      const payload = {
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 29,
        note: `CHARGE PAGE TEST — $${String(amount || '0.00')} · ${String(purpose || 'Payment')} · by ${String(agent || 'unknown')}. HawkLink launch test — no money moved. Safe to ignore.`,
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

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

    if (action === 'clover_recent_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const CTOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !CTOK) return res.status(200).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var in Vercel' });
      const r = await fetch(`https://api.clover.com/v3/merchants/${MID}/payments?limit=15&expand=tender,employee&orderBy=createdTime%20DESC`, {
        headers: { Authorization: `Bearer ${CTOK}` },
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const payments = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        time: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        tender: p.tender && p.tender.label,
        employee: p.employee && (p.employee.name || p.employee.id),
        note: p.note || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: payments.length, payments } });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 29, // Online From Insured
        logNote: 'TEST RECEIPT — $1.00 posted via Partner API from the admin Test Lab (Clover integration test). Not a real payment. Safe to void/delete.',
        total: 1.00,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const CMID = process.env.CLOVER_MERCHANT_ID;
      const CTOK = process.env.CLOVER_API_TOKEN;
      if (!CMID || !CTOK) return res.status(200).json({ ok: false, error: 'CLOVER_MERCHANT_ID / CLOVER_API_TOKEN env vars not set (or deployment predates them)' });
      const r = await fetch(`https://api.clover.com/v3/merchants/${CMID}/payments?limit=15&expand=tender,employee,order,cardTransaction&orderBy=createdTime%20DESC`, {
        headers: { Authorization: `Bearer ${CTOK}` },
      });
      if (!r.ok) {
        const t = await r.text();
        return res.status(200).json({ ok: false, error: `Clover HTTP ${r.status}`, detail: t.slice(0, 300) });
      }
      const data = await r.json();
      const payments = (data.elements || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        time: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        tender: p.tender && (p.tender.label || p.tender.labelKey) || null,
        last4: p.cardTransaction && p.cardTransaction.last4 || null,
        note: p.order && p.order.note || p.note || null,
        orderId: p.order && p.order.id || null,
      }));
      return res.status(200).json({ ok: true, merchant: CMID, count: payments.length, payments });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const amount = 1.00; // hard-coded test amount by design
      const receipt = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        policyId: null,
        officeId: null, // defaults to the client's office
        channel: 29, // Online From Insured
        logNote: 'TEST RECEIPT $1.00 — written via Partner API from the admin Test Lab to validate the Clover→HawkSoft accounting pipeline. Safe to void/delete.',
        total: amount,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(receipt),
      });
      return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: r.body });
    }

    if (action === 'create_test_receipt') {
      const clientId = parseInt((req.body || {}).clientId, 10) || 26081; // default: ZZTEST fixture
      const amount = Math.min(Math.abs(parseFloat((req.body || {}).amount) || 1.0), 5.0); // test cap $5
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        policyId: null,
        officeId: null,
        channel: 31, // Online From Agency Staff
        logNote: `TEST RECEIPT — $${amount.toFixed(2)} posted via Partner API from the admin Test Lab to validate the Clover→HawkSoft receipt pipeline. Not a real payment. Safe to void/ignore.`,
        payMethod: 'Other',
        total: amount,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const TOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !TOK) return res.status(500).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var (redeploy needed after adding)' });
      const limit = Math.min(parseInt((req.body || {}).limit, 10) || 15, 50);
      const r = await fetch(
        `https://api.clover.com/v3/merchants/${MID}/payments?limit=${limit}&orderBy=createdTime%20DESC&expand=employee,order,cardTransaction`,
        { headers: { Authorization: `Bearer ${TOK}` } }
      );
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const pays = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        currency: p.currency || 'USD',
        created: p.createdTime ? new Date(p.createdTime).toISOString() : null,
        result: p.result,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        device: p.device && p.device.id || null,
        orderId: p.order && p.order.id || null,
        note: (p.note || (p.order && p.order.note) || '').slice(0, 120),
        last4: p.cardTransaction && p.cardTransaction.last4 || null,
        cardType: p.cardTransaction && p.cardTransaction.cardType || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: pays.length, payments: pays } });
    }

    if (action === 'create_receipt') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const total = Math.round(parseFloat(b.amount) * 100) / 100;
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!total || total <= 0 || total > 10) {
        return res.status(400).json({ ok: false, error: 'Test receipts are capped at $10.00 — amount must be between $0.01 and $10.00' });
      }
      const payload = [{
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 21, // Walk In From Insured
        payMethod: b.payMethod || 'CreditCard',
        logNote: String(b.logNote || 'TEST RECEIPT — posted via Partner API from the admin Test Lab (Clover integration test). Safe to void.').slice(0, 1000),
        total,
      }];
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'clover_payments') {
      const MID = process.env.CLOVER_MERCHANT_ID;
      const TOK = process.env.CLOVER_API_TOKEN;
      if (!MID || !TOK) return res.status(500).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var' });
      const url = `https://api.clover.com/v3/merchants/${MID}/payments?limit=15&orderBy=${encodeURIComponent('createdTime DESC')}&expand=${encodeURIComponent('employee,order,tender')}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TOK}` } });
      const body = await r.json().catch(() => null);
      if (!r.ok) return res.status(200).json({ ok: false, httpStatus: r.status, result: body });
      const payments = ((body && body.elements) || []).map(p => ({
        id: p.id,
        amount: (p.amount || 0) / 100,
        result: p.result,
        time: p.createdTime ? new Date(p.createdTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : null,
        employee: p.employee && (p.employee.name || p.employee.id) || null,
        tender: p.tender && (p.tender.label || p.tender.labelKey) || null,
        note: (p.order && p.order.note) || p.note || null,
        orderId: p.order && p.order.id || null,
      }));
      return res.status(200).json({ ok: true, httpStatus: 200, result: { count: payments.length, payments } });
    }

    if (action === 'create_receipt') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const total = Math.round(parseFloat(b.total) * 100) / 100;
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!total || total <= 0 || total > 10000) return res.status(400).json({ ok: false, error: 'total must be between 0.01 and 10000' });
      const receipt = {
        refId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        channel: 21, // Walk In From Insured
        logNote: String(b.logNote || `Payment receipt recorded via Speedy admin (Clover bridge test). Amount: $${total.toFixed(2)}`).slice(0, 3000),
        total,
      };
      if (b.payMethod) receipt.payMethod = String(b.payMethod);
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/receipts?version=4.0`, {
        method: 'POST', body: JSON.stringify([receipt]),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'smart_task') {
      const clientId = parseInt((req.body || {}).clientId, 10);
      const email = String((req.body || {}).assignedToEmail || '').trim();
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!email) return res.status(400).json({ ok: false, error: 'assignedToEmail required (a HawkSoft user email)' });
      const now = new Date();
      // Simulates the output of AI extraction from the attached dec page (smart-intake pipeline).
      const payload = {
        refId: crypto.randomUUID(),
        ts: now.toISOString(),
        channel: 31,
        note: 'SMART INTAKE (TEST) \u2014 Dec page received, filed to attachments.\n'
          + 'EXTRACTED VALUES \u2014 double-click a value to copy:\n'
          + '\n'
          + 'Policy #: ZZT-PA-2026-0001\n'
          + 'Carrier: Kemper Auto\n'
          + 'LOB: Personal Auto\n'
          + 'Effective: 08/01/2026\n'
          + 'Expiration: 02/01/2027\n'
          + 'Term: 6 months\n'
          + 'Premium: 1842.00\n'
          + 'Named insured: ZZTEST DELETE ME - API TEST\n'
          + 'Vehicle: 2018 Toyota Camry LE\n'
          + 'VIN: 4T1B11HK5JU999999\n'
          + 'BI: 25/50\n'
          + 'PD: 25000\n'
          + 'UM: 25/50\n'
          + 'Comp ded: 500\n'
          + 'Coll ded: 500',
        task: {
          title: 'Enter policy from attached dec (TEST)',
          description: 'TEST of the smart-intake pipeline \u2014 no real policy exists.\n'
            + 'Enter in CMS \u2014 one value per line, ready to copy:\n'
            + '\n'
            + 'Policy #: ZZT-PA-2026-0001\n'
            + 'Carrier: Kemper Auto\n'
            + 'LOB: Personal Auto\n'
            + 'Effective: 08/01/2026\n'
            + 'Expiration: 02/01/2027\n'
            + 'Premium: 1842.00\n'
            + 'Vehicle: 2018 Toyota Camry LE\n'
            + 'VIN: 4T1B11HK5JU999999\n'
            + 'BI: 25/50 | PD: 25000 | UM: 25/50\n'
            + 'Comp/Coll ded: 500\n'
            + '\n'
            + 'Dec page PDF is in the client\u2019s Attachments tab.',
          dueDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: email,
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200 || r.status === 202, httpStatus: r.status, result: r.body });
    }

    if (action === 'create_client') {
      const b = req.body || {};
      const first = String(b.firstName || '').trim().slice(0, 14);
      const last = String(b.lastName || '').trim().slice(0, 24);
      if (!first || !last) return res.status(400).json({ ok: false, error: 'firstName and lastName required' });
      const officeId = parseInt(b.officeId, 10);
      if (!officeId && officeId !== 0) return res.status(400).json({ ok: false, error: 'officeId required' });
      const contacts = [];
      if (b.phone) contacts.push({ type: 'CellPhone', value: String(b.phone).trim().slice(0, 128) });
      if (b.email) contacts.push({ type: 'HomeEmail', value: String(b.email).trim().slice(0, 128) });
      const payload = {
        officeId,
        status: ['Active', 'Lead', 'Prospect'].includes(b.status) ? b.status : 'Lead',
        source: String(b.source || 'Speedy Intake').trim().slice(0, 14),
        people: [{
          firstName: first,
          lastName: last,
          mainContactType: 'First',
          ...(b.dob ? { dateOfBirth: String(b.dob).trim() } : {}),
          ...(contacts.length ? { contacts } : {}),
        }],
        ...(b.address1 ? {
          mailingAddress: {
            address1: String(b.address1).trim().slice(0, 40),
            city: String(b.city || '').trim().slice(0, 19),
            state: String(b.state || 'CA').trim().slice(0, 2),
            zip: String(b.zip || '').trim().slice(0, 10),
          },
        } : {}),
        ...(b.policyNumber ? {
          policy: {
            applicationType: ['Personal', 'Commercial', 'Life', 'Health'].includes(b.applicationType) ? b.applicationType : 'Personal',
            policyNumber: String(b.policyNumber).trim().slice(0, 25),
            ...(b.effectiveDate ? { effectiveDate: String(b.effectiveDate).trim() } : {}),
            ...(b.lob ? { LOBs: [mapLob(b.lob)] } : {}),
            state: 'CA',
          },
        } : {}),
        log: {
          channel: 31,
          note: 'Client created via Speedy admin intake' + (b.policyNumber ? ` with policy shell ${String(b.policyNumber).trim().slice(0, 25)}` : '') + '. Complete policy details in CMS from the dec page.',
          ts: new Date().toISOString(),
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: r.body });
    }

    if (action === 'intake_task') {
      const b = req.body || {};
      const clientId = parseInt(b.clientId, 10);
      const email = String(b.assignedToEmail || '').trim();
      if (!clientId) return res.status(400).json({ ok: false, error: 'clientId required' });
      if (!email) return res.status(400).json({ ok: false, error: 'assignedToEmail required' });
      const f = b.fields || {};
      const order = [
        ['policyNumber', 'Policy #'], ['carrier', 'Carrier'], ['lob', 'LOB'],
        ['effective', 'Effective'], ['expiration', 'Expiration'], ['premium', 'Premium'],
        ['vehicle', 'Vehicle'], ['vin', 'VIN'], ['coverages', 'Coverages'], ['notes', 'Notes'],
      ];
      const lines = order
        .filter(([k]) => f[k] && String(f[k]).trim())
        .map(([k, label]) => `${label}: ${String(f[k]).trim().slice(0, 120)}`);
      if (!lines.length) return res.status(400).json({ ok: false, error: 'At least one extracted field required' });
      const block = lines.join('\n');
      const now = new Date();
      const payload = {
        refId: crypto.randomUUID(),
        ts: now.toISOString(),
        channel: 31,
        note: 'SMART INTAKE \u2014 Dec page received, filed to attachments.\nEXTRACTED VALUES \u2014 one per line, ready to copy:\n\n' + block,
        task: {
          title: 'Enter policy from attached dec',
          description: 'Enter in CMS \u2014 one value per line, ready to copy:\n\n' + block + '\n\nDec page PDF is in the client\u2019s Attachments tab.',
          dueDate: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
          assignedToRole: 'SpecifiedUser',
          assignedToEmail: email,
        },
      };
      const r = await hs(`/vendor/agency/${AGENCY_ID}/client/${clientId}/log?version=4.0`, {
        method: 'POST', body: JSON.stringify(payload),
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
