// /api/calls — read-only view of call activity for /admin/calls.html.
//
// ACCESS: Google ID token (header x-id-token), same admin allowlist as
// /api/platform. Reads the call_sessions view, which rolls RingCentral's
// per-leg rows up into one row per actual call.
//
//   GET /api/calls?days=1          -> sessions in the last N days
//   GET /api/calls?days=7&agent=.. -> filtered to one agent
//   GET /api/calls?session=<id>    -> every leg of one call, for the detail view

const ADMIN_ALLOWLIST = ['info@speedyins.com'];

const OFFICES = {
  1: 'Moreno Valley',
  2: 'Riverside — Van Buren',
  3: 'Riverside — Magnolia',
  4: 'Lake Elsinore',
};

async function verifyGoogle(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken)
    );
    if (!r.ok) return null;
    const j = await r.json();
    const email = String(j.email || '').toLowerCase();
    if (j.email_verified !== 'true' && j.email_verified !== true) return null;
    return ADMIN_ALLOWLIST.includes(email) ? email : null;
  } catch {
    return null;
  }
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return {
    base: url.replace(/\/$/, ''),
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  };
}

const pretty = (p) =>
  p && p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p || '';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const email = await verifyGoogle(req.headers['x-id-token']);
  if (!email) return res.status(403).json({ error: 'Not authorized' });

  const s = sb();
  if (!s) return res.status(500).json({ error: 'Supabase env vars missing' });

  const q = req.query || {};

  // ---- detail: every leg of one call --------------------------------------
  if (q.session) {
    const url =
      `${s.base}/rest/v1/call_log` +
      `?rc_session_id=eq.${encodeURIComponent(String(q.session))}` +
      `&select=rc_party_id,direction,from_number,to_number,agent_name,agent_email,` +
      `result,status_code,disconnect_reason,started_at,answered_at,ended_at,duration_seconds` +
      `&order=rc_party_id.asc`;
    const r = await fetch(url, { headers: s.headers });
    const legs = await r.json().catch(() => []);
    return res.status(200).json({
      email,
      session: String(q.session),
      legs: Array.isArray(legs)
        ? legs.map((l) => ({
            ...l,
            from_pretty: pretty(l.from_number),
            to_pretty: pretty(l.to_number),
          }))
        : [],
    });
  }

  // ---- list: rolled-up sessions -------------------------------------------
  const days = Math.min(90, Math.max(1, Number(q.days) || 1));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  let url =
    `${s.base}/rest/v1/call_sessions` +
    `?or=(ring_start.gte.${since},call_end.gte.${since})` +
    `&order=ring_start.desc.nullslast&limit=500`;

  if (q.agent) url += `&answered_by=eq.${encodeURIComponent(String(q.agent))}`;
  if (q.office) url += `&office_id=eq.${encodeURIComponent(String(q.office))}`;
  if (q.outcome) url += `&outcome=eq.${encodeURIComponent(String(q.outcome))}`;

  const r = await fetch(url, { headers: s.headers });
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows)) {
    return res.status(502).json({ error: 'Supabase read failed', detail: rows });
  }

  const calls = rows.map((c) => ({
    ...c,
    customer_pretty: pretty(c.customer_number),
    office_name: OFFICES[c.office_id] || (c.office_id ? `Office ${c.office_id}` : null),
  }));

  // Summary strip. Computed here so the page stays dumb.
  const answered = calls.filter((c) => c.outcome === 'Answered');
  const talk = answered.reduce((n, c) => n + (Number(c.talk_seconds) || 0), 0);

  const byAgent = {};
  for (const c of calls) {
    if (c.answered_by) {
      const a = (byAgent[c.answered_by] ||= { agent: c.answered_by, answered: 0, talk: 0, missedWhileRinging: 0 });
      a.answered += 1;
      a.talk += Number(c.talk_seconds) || 0;
    }
    for (const name of c.rang_agents || []) {
      (byAgent[name] ||= { agent: name, answered: 0, talk: 0, missedWhileRinging: 0 })
        .missedWhileRinging += 1;
    }
  }

  return res.status(200).json({
    email,
    days,
    stats: {
      total: calls.length,
      answered: answered.length,
      missed: calls.length - answered.length,
      answerRate: calls.length ? Math.round((answered.length / calls.length) * 100) : 0,
      talkSeconds: talk,
      avgTalk: answered.length ? Math.round(talk / answered.length) : 0,
      matched: calls.filter((c) => c.matched).length,
    },
    agents: Object.values(byAgent).sort((a, b) => b.answered - a.answered),
    calls,
  });
}
