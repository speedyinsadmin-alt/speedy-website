export const config = { maxDuration: 30 };
// /api/platform — read-only backend for the Platform Console (admin/platform.html).
// ACCESS: Google ID token required on every request (header x-id-token).
//         Allowlist = Saif only for now; widen ALLOWLIST later (Tony, agents).
// DATA:   HawkSoft Partner API (ZZTEST #26081 only — hard-locked) + Supabase (bridge_ledger, clover_tokens).
// No writes. No PII beyond the ZZTEST fixture.

// ACCESS v1.1: password gate (header x-console-key must equal ADMIN_API_KEY env var).
// Google Sign-In + allowlist returns when Saif has a @speedyins.com account (OAuth app is org-internal).
const AGENCY_ID = 15112;
const TEST_CLIENT = 26081; // ZZTEST — the only client this endpoint will serve
const HS_BASE = 'https://integration.hawksoft.app';

import { timingSafeEqual } from 'node:crypto';
function verifyKey(key) {
  const real = process.env.CONSOLE_KEY || process.env.ADMIN_API_KEY || '';
  if (!real || !key) return false;
  const a = Buffer.from(String(key)), b = Buffer.from(real);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}` } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  if (!verifyKey(req.headers['x-console-key'])) return res.status(401).json({ ok: false, error: 'Not authorized' });
  const email = 'console-admin';

  const view = String(req.query.view || '');

  /* ---- HawkSoft: ZZTEST client, policies, invoices ---- */
  if (view === 'client') {
    const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
    if (!ID || !SECRET) return res.status(500).json({ ok: false, error: 'HawkSoft env vars missing' });
    const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
    const r = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${TEST_CLIENT}?version=4.0&include=Details,People,Contacts,Policies,Invoices`, {
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    });
    const text = await r.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return res.status(200).json({ ok: r.status === 200, status: r.status, email, client: body });
  }

  /* ---- Supabase: bridge_ledger latest rows ---- */
  if (view === 'ledger') {
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });
    const r = await fetch(`${s.base}/rest/v1/bridge_ledger?select=*&order=created_at.desc&limit=50`, { headers: s.hdrs });
    const rows = await r.json().catch(() => []);
    return res.status(200).json({ ok: r.ok, email, rows: Array.isArray(rows) ? rows : [], raw: Array.isArray(rows) ? undefined : rows });
  }

  /* ---- Supabase: table inventory + row counts ---- */
  if (view === 'tables') {
    const s = sb();
    if (!s) return res.status(500).json({ ok: false, error: 'Supabase env vars missing' });
    const known = ['bridge_ledger', 'clover_tokens'];
    const out = [];
    for (const t of known) {
      const r = await fetch(`${s.base}/rest/v1/${t}?select=*&limit=1`, {
        headers: { ...s.hdrs, Prefer: 'count=exact' },
      });
      const range = r.headers.get('content-range') || '';
      const count = range.includes('/') ? Number(range.split('/')[1]) : null;
      const sample = await r.json().catch(() => []);
      out.push({
        table: t,
        exists: r.ok,
        rows: isFinite(count) ? count : null,
        columns: Array.isArray(sample) && sample[0] ? Object.keys(sample[0]) : [],
      });
    }
    return res.status(200).json({ ok: true, email, tables: out });
  }

  return res.status(400).json({ ok: false, error: 'Unknown view. Use view=client | ledger | tables' });
}
