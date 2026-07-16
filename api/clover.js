// /api/clover — Clover payments + HawkSoft receipt bridge (Test Lab phase).
// Env vars: CLOVER_MERCHANT_ID, CLOVER_API_TOKEN, HAWKSOFT_CLIENT_ID, HAWKSOFT_SECRET, ADMIN_API_KEY.
// POST only. ALL actions require header  x-admin-key: <ADMIN_API_KEY>.
//
// Actions:
//   recent_payments — read-only list of latest Clover payments (sanitized; no card data)
//   test_receipt    — post a $1.00 TEST receipt to HawkSoft client 26081 (ZZTEST fixture)

const AGENCY_ID = 15112;
const ZZTEST_CLIENT = 26081;
const HS_BASE = 'https://integration.hawksoft.app';
const CLOVER_BASE = 'https://api.clover.com';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const KEY = process.env.ADMIN_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'ADMIN_API_KEY env var not set' });
  if ((req.headers['x-admin-key'] || '') !== KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
  }

  const { action } = req.body || {};

  if (action === 'recent_payments') {
    const MID = process.env.CLOVER_MERCHANT_ID;
    const TOKEN = process.env.CLOVER_API_TOKEN;
    if (!MID || !TOKEN) return res.status(500).json({ ok: false, error: 'Missing CLOVER_MERCHANT_ID or CLOVER_API_TOKEN env var' });

    const r = await fetch(`${CLOVER_BASE}/v3/merchants/${MID}/payments?limit=15&orderBy=createdTime%20DESC&expand=employee,order,tender`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(200).json({ ok: false, httpStatus: r.status, error: 'Clover API error', detail: t.slice(0, 400) });
    }
    const data = await r.json();
    const payments = (data.elements || []).map(p => ({
      amount: p.amount != null ? (p.amount / 100).toFixed(2) : null,
      time: p.createdTime ? new Date(p.createdTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : null,
      result: p.result || null,
      employee: (p.employee && (p.employee.name || p.employee.nickname)) || null,
      note: (p.order && p.order.note) ? String(p.order.note).slice(0, 80) : null,
      tender: (p.tender && p.tender.label) || null,
    }));
    return res.status(200).json({ ok: true, count: payments.length, payments });
  }

  if (action === 'test_receipt') {
    const ID = process.env.HAWKSOFT_CLIENT_ID;
    const SECRET = process.env.HAWKSOFT_SECRET;
    if (!ID || !SECRET) return res.status(500).json({ ok: false, error: 'Missing HawkSoft env vars' });
    const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');

    const payload = [{
      refId: crypto.randomUUID(),
      ts: new Date().toISOString(),
      channel: 31, // Online From Agency Staff
      logNote: 'TEST RECEIPT — $1.00 posted via Partner API from the admin Test Lab to validate the Clover→HawkSoft receipt pipeline. Not a real payment. Safe to void/delete.',
      total: 1.00,
      officeId: 1, // Moreno Valley
    }];

    const r = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${ZZTEST_CLIENT}/receipts?version=4.0`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return res.status(200).json({ ok: r.status === 200, httpStatus: r.status, result: body });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
