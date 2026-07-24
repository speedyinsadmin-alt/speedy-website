// /api/screenpop — caller number -> HawkSoft client, for GoTo/RingCentral screen pop.
//
// This is the endpoint a phone vendor points at. It keeps our HawkSoft credentials
// inside our own infrastructure: the vendor only ever sees the resolved client,
// never an API key.
//
//   GET /api/screenpop?caller=${CNUM}&token=<SCREENPOP_TOKEN>
//        -> small HTML card an agent can read at a glance while the phone rings
//   GET /api/screenpop?caller=...&token=...&format=json
//        -> { ok, found, clientNumber, name, officeId }
//
// Phone numbers are normalized to bare 10 digits on both sides, because HawkSoft
// stores them as (###)###-#### and vendors send E.164 (+1##########).

const OFFICES = { 0: 'Primary', 1: 'Moreno Valley', 2: 'Riverside — Van Buren', 3: 'Riverside — Magnolia', 4: 'Lake Elsinore' };

const digits10 = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
};
const pretty = (p) => (p ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function card(title, lines, accent) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0b1a2e;color:#eaf2ff;
      display:flex;align-items:center;justify-content:center;min-height:100vh}
 .c{background:#12253f;border:1px solid rgba(255,255,255,.12);border-left:5px solid ${accent};
    border-radius:12px;padding:22px 26px;max-width:420px;width:90%}
 h1{margin:0 0 10px;font-size:20px}
 p{margin:4px 0;font-size:15px;color:#cfe0f5}
 .n{font-size:13px;color:#8fa6c2;margin-top:14px}
</style></head><body><div class="c"><h1>${esc(title)}</h1>${lines}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const wantJson = String(q.format || '').toLowerCase() === 'json';

  const TOKEN = process.env.SCREENPOP_TOKEN;
  const ADMIN = process.env.ADMIN_API_KEY;
  const supplied = String(q.token || req.headers['x-admin-key'] || '');
  const authed = (TOKEN && supplied === TOKEN) || (ADMIN && supplied === ADMIN);
  if (!authed) {
    if (wantJson) return res.status(401).json({ ok: false, error: 'Invalid or missing token' });
    res.setHeader('Content-Type', 'text/html');
    return res.status(401).send(card('Not authorized', '<p>This lookup requires a valid token.</p>', '#ef4444'));
  }

  const phone = digits10(q.caller || q.phone || q.number);
  if (!phone) {
    if (wantJson) return res.status(200).json({ ok: false, error: 'No usable 10-digit caller number' });
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(card('No caller ID', '<p>The call arrived without a usable number (blocked or private).</p>', '#f59e0b'));
  }

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    if (wantJson) return res.status(500).json({ ok: false, error: 'SUPABASE env vars missing' });
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(card('Lookup unavailable', '<p>Index storage is not configured.</p>', '#ef4444'));
  }

  const base = url.replace(/\/$/, '');
  let row = null;
  try {
    const r = await fetch(`${base}/rest/v1/client_phone_index?phone10=eq.${phone}&select=*&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const rows = await r.json().catch(() => []);
    row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    row = null;
  }

  if (wantJson) {
    return res.status(200).json({
      ok: true, found: !!row, phone,
      clientNumber: row ? row.client_number : null,
      name: row ? row.display_name : null,
      officeId: row ? row.office_id : null,
      office: row && OFFICES[row.office_id] ? OFFICES[row.office_id] : null,
    });
  }

  res.setHeader('Content-Type', 'text/html');
  if (!row) {
    return res.status(200).send(card('New caller', `
      <p><strong>${esc(pretty(phone))}</strong></p>
      <p>No client found with this number.</p>
      <p class="n">Treat as a new lead — create the client in HawkSoft after the call.</p>`, '#f59e0b'));
  }

  const office = OFFICES[row.office_id] || (row.office_id != null ? `Office ${row.office_id}` : '');
  return res.status(200).send(card('Client calling', `
    <p style="font-size:22px;font-weight:600;color:#fff">${esc(row.display_name || 'Client')}</p>
    <p>HawkSoft client #<strong>${esc(row.client_number)}</strong></p>
    <p>${esc(pretty(phone))}${office ? ' · ' + esc(office) : ''}</p>
    <p class="n">Search this client number in HawkSoft to open the record.</p>`, '#22c55e'));
}
