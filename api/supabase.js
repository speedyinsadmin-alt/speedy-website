// /api/supabase — server-side proxy to the Supabase Management API.
// Reads SUPABASE_PAT + SUPABASE_PROJECT_REF from Vercel env vars.
// The token never reaches the browser; the admin page only sees the JSON below.

const SPECS = {
  nano:  { cpu: '2-core ARM (shared)', ram: '0.5 GB' },
  micro: { cpu: '2-core ARM (shared)', ram: '1 GB' },
  small: { cpu: '2-core ARM',          ram: '2 GB' },
  medium:{ cpu: '2-core ARM',          ram: '4 GB' },
  large: { cpu: '2-core ARM',          ram: '8 GB' },
  xl:    { cpu: '4-core ARM',          ram: '16 GB' },
  '2xl': { cpu: '8-core ARM',          ram: '32 GB' },
  '4xl': { cpu: '16-core ARM',         ram: '64 GB' },
  '8xl': { cpu: '32-core ARM',         ram: '128 GB' },
  '12xl':{ cpu: '48-core ARM',         ram: '192 GB' },
  '16xl':{ cpu: '64-core ARM',         ram: '256 GB' },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const PAT = process.env.SUPABASE_PAT;
  const REF = process.env.SUPABASE_PROJECT_REF;
  if (!PAT || !REF) {
    return res.status(500).json({ ok: false, error: 'Missing SUPABASE_PAT or SUPABASE_PROJECT_REF env var' });
  }

  const BASE = 'https://api.supabase.com/v1';
  const H = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };
  const out = { ok: true, ref: REF, errors: [] };

  const get = async (path) => {
    const r = await fetch(BASE + path, { headers: H });
    if (!r.ok) throw new Error(`${path.replace('/projects/' + REF, '')} → HTTP ${r.status}`);
    return r.json();
  };

  // 1) Project details
  try {
    const p = await get(`/projects/${REF}`);
    out.name = p.name;
    out.status = p.status;                       // e.g. ACTIVE_HEALTHY
    out.region = p.region;
    out.pgVersion = (p.database && p.database.version) || null;
    out.createdAt = p.created_at;
    out.orgId = p.organization_id;
  } catch (e) { out.errors.push('project ' + e.message); }

  // 2) Compute size → CPU / RAM
  try {
    const a = await get(`/projects/${REF}/billing/addons`);
    const sel = (a.selected_addons || []).find(x => x.type === 'compute_instance');
    const ident = sel && sel.variant && (sel.variant.identifier || sel.variant.name) || null;
    let key = ident ? String(ident).replace(/^ci_/, '').toLowerCase() : 'nano';
    const spec = SPECS[key] || SPECS.nano;
    out.computeSize = key.toUpperCase();
    const meta = (sel && sel.variant && sel.variant.meta) || {};
    out.cpu = meta.cpu_cores ? `${meta.cpu_cores}-core` : spec.cpu;
    out.ram = meta.memory_gb ? `${meta.memory_gb} GB` : spec.ram;
  } catch (e) {
    out.errors.push('compute ' + e.message);
    out.computeSize = 'NANO'; out.cpu = SPECS.nano.cpu; out.ram = SPECS.nano.ram;
  }

  // 3) Plan / tier (org level; not always exposed — infer if absent)
  try {
    const orgs = await get(`/organizations`);
    const org = Array.isArray(orgs) ? orgs.find(o => o.id === out.orgId) : null;
    const plan = org && (org.plan && (org.plan.name || org.plan) || org.tier) || null;
    if (plan) { out.tier = String(plan); }
    else { out.tier = out.computeSize === 'NANO' ? 'Free' : 'Paid'; out.tierInferred = true; }
    if (org && org.name) out.orgName = org.name;
  } catch (e) {
    out.errors.push('org ' + e.message);
    out.tier = out.computeSize === 'NANO' ? 'Free' : null;
    out.tierInferred = true;
  }

  // 4) Database size used (real usage via a lightweight SQL query)
  try {
    const r = await fetch(`${BASE}/projects/${REF}/database/query`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ query: 'select pg_database_size(current_database()) as bytes;' }),
    });
    if (!r.ok) throw new Error('query → HTTP ' + r.status);
    const rows = await r.json();
    const bytes = Array.isArray(rows) ? Number(rows[0] && rows[0].bytes) : NaN;
    if (!isNaN(bytes)) out.dbSizeBytes = bytes;
  } catch (e) { out.errors.push('db size ' + e.message); }

  return res.status(200).json(out);
}
