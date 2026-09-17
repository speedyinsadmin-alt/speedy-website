// /api/rc-subscribe — manage the RingCentral webhook subscription.
//
// Subscriptions expire (7 days max) and RingCentral disables one after repeated
// delivery failures. This endpoint is how we create, inspect and renew it.
//
//   GET  /api/rc-subscribe?token=<ADMIN_API_KEY>              -> list current subscriptions
//   GET  /api/rc-subscribe?token=<ADMIN_API_KEY>&action=create -> create/replace
//   GET  /api/rc-subscribe?token=<ADMIN_API_KEY>&action=renew  -> extend expiry
//        (also run daily by Vercel Cron, authenticated via CRON_SECRET)
//   GET  /api/rc-subscribe?token=<ADMIN_API_KEY>&action=delete&id=<subId>
//
// IMPORTANT: after creating, always read `disabledFilters` in the response.
// A missing permission shows up there, not as an error — the subscription is
// created successfully and then silently delivers nothing.

const RC_BASE = () =>
  (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');

// Account-wide: every extension across all four branches.
const EVENT_FILTERS = ['/restapi/v1.0/account/~/telephony/sessions'];

let tokenCache = { value: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const basic = Buffer.from(
    `${process.env.RC_CLIENT_ID}:${process.env.RC_CLIENT_SECRET}`
  ).toString('base64');

  const r = await fetch(`${RC_BASE()}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: process.env.RC_JWT,
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = r.status === 429 ? ' (Auth limit is 5 requests/60s — wait a minute and retry once)' : '';
    throw new Error(`auth HTTP ${r.status}${hint}: ${j.error_description || j.error || ''}`);
  }
  tokenCache = {
    value: j.access_token,
    expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000,
  };
  return j.access_token;
}

const rc = async (token, path, init = {}) => {
  const r = await fetch(RC_BASE() + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, json, text };
};

function callbackUrl() {
  const host = process.env.PUBLIC_BASE_URL || 'https://speedyins.com';
  return `${host.replace(/\/$/, '')}/api/rc-webhook?token=${encodeURIComponent(
    process.env.RC_WEBHOOK_TOKEN || ''
  )}`;
}

// RingCentral caps subscription lifetime; ask for the max and renew on a cron.
const expiresIn = 60 * 60 * 24 * 7;

/* ---------------------------------------------------------------------------
   SMS into the Inbox (Sep 17 2026) — its own subscription, delivered to
   /api/rc-sms, one message-store/instant filter per extension that owns an
   SMS-capable number. Kept apart from the telephony subscription on purpose:
   the renew below never touches it, and a failure here never touches calls.
--------------------------------------------------------------------------- */
const SMS_ADDRESS = () => callbackUrl().replace('/api/rc-webhook', '/api/rc-sms');
/* the branch lines the website prints; every other number is mapped by its extension's agent */
const BRANCH_LINES = { '9514720927': 'mv', '9516951500': 'vb', '9519779400': 'mg', '9515794095': 'le', '9095876001': 'co' };
const BRANCH_OF_NAME = { 'Moreno Valley': 'mv', 'Riverside Van Buren': 'vb', 'Riverside 01': 'vb', 'Riverside Magnolia': 'mg', 'Riverside 02': 'mg', 'Lake Elsinore': 'le', 'Colton': 'co' };
const sbEnv = () => ({ base: (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key: process.env.SUPABASE_SERVICE_ROLE_KEY || '' });
const sbHdrs = (k) => ({ apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' });
const d10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : (d.length === 10 ? d : null); };
const norm = (v) => String(v || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);

/* every number the account owns -> rc_numbers, with branch + agent mapped where we can */
async function refreshNumbers(token) {
  const r = await rc(token, '/restapi/v1.0/account/~/phone-number?perPage=500');
  if (!r.ok) throw new Error(`phone-number HTTP ${r.status}`);
  /* Sep 17: the account-level listing carries the extension id but NOT its name, and
     no `features` at all - so names come from the extension list and SMS capability
     is inferred from the number type (every local Direct/Company/Main number on this
     account is on the approved 10DLC campaign; toll-free and fax are not). */
  const exts = await rc(token, '/restapi/v1.0/account/~/extension?perPage=500');
  const extById = {};
  for (const e of (exts.ok && exts.json && exts.json.records) || []) extById[String(e.id)] = { name: e.name || (e.contact ? [e.contact.firstName, e.contact.lastName].filter(Boolean).join(' ') : ''), number: String(e.extensionNumber || ''), type: e.type || '' };
  const TOLL_FREE = /^\+1(800|833|844|855|866|877|888)/;
  const { base, key } = sbEnv();
  const agents = await fetch(`${base}/rest/v1/agents?active=is.true&select=email,full_name,branch`, { headers: sbHdrs(key) }).then((x) => x.json()).catch(() => []);
  /* what is already in the table wins where the automatic guess has nothing: Saif maps
     the rest by hand (Sammy = Samuel, Esme = Esmeralda, Tony signs in as info@) and a
     nightly refresh must never undo that */
  const existing = {};
  for (const e of await fetch(`${base}/rest/v1/rc_numbers?select=phone10,branch,agent_email`, { headers: sbHdrs(key) }).then((x) => x.json()).catch(() => [])) existing[e.phone10] = e;
  const rows = [];
  for (const n of (r.json && r.json.records) || []) {
    const phone10 = d10(n.phoneNumber); if (!phone10) continue;
    const feats = Array.isArray(n.features) ? n.features : [];
    const ext = n.extension ? extById[String(n.extension.id)] : null;
    const extName = n.extension ? (n.extension.name || (ext && ext.name) || '') : '';
    const usage = n.usageType || '';
    const smsCapable = feats.includes('SmsSender') || (!feats.length && /^(DirectNumber|CompanyNumber|MainCompanyNumber)$/.test(usage) && !TOLL_FREE.test(n.phoneNumber || ''));
    let agent = null;
    if (n.extension && extName) {
      const toks = norm(extName);
      const hits = (Array.isArray(agents) ? agents : []).filter((a) => { const t = norm(a.full_name); return t.length >= 2 && t[0] && t[t.length - 1] && toks.includes(t[0]) && toks.includes(t[t.length - 1]); });
      if (hits.length === 1) agent = hits[0];
      else { const byFirst = (Array.isArray(agents) ? agents : []).filter((a) => { const t = norm(a.full_name); return t[0] && toks.includes(t[0]); }); if (byFirst.length === 1) agent = byFirst[0]; }
    }
    rows.push({
      phone10, e164: n.phoneNumber, extension_id: n.extension ? String(n.extension.id) : null, extension_number: n.extension ? String(n.extension.extensionNumber || (ext && ext.number) || '') : null,
      extension_name: extName || null, usage_type: usage || null, sms: smsCapable,
      branch: BRANCH_LINES[phone10] || (agent && BRANCH_OF_NAME[agent.branch]) || (existing[phone10] && existing[phone10].branch) || null,
      agent_email: (existing[phone10] && existing[phone10].agent_email) || (agent ? agent.email : null), label: n.label || null, updated_at: new Date().toISOString(),
    });
  }
  if (rows.length) {
    const up = await fetch(`${base}/rest/v1/rc_numbers`, { method: 'POST', headers: { ...sbHdrs(key), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    if (!up.ok) throw new Error(`rc_numbers upsert HTTP ${up.status}`);
  }
  return rows;
}
const smsFilters = (rows) => [...new Set(rows.filter((x) => x.sms && x.extension_id).map((x) => x.extension_id))].map((id) => `/restapi/v1.0/account/~/extension/${id}/message-store/instant?type=SMS`);
async function saveSmsSub(id) {
  const { base, key } = sbEnv();
  await fetch(`${base}/rest/v1/chat_settings`, { method: 'POST', headers: { ...sbHdrs(key), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key: 'rc_sms_subscription', value: id ? JSON.stringify(id) : 'null', updated_at: new Date().toISOString() }]) }).catch(() => {});
}
async function smsCreate(token) {
  const rows = await refreshNumbers(token);
  const filters = smsFilters(rows);
  if (!filters.length) return { ok: false, error: 'No SMS-capable numbers with an extension were found' };
  const list = await rc(token, '/restapi/v1.0/subscription');
  for (const sub of (list.json && list.json.records) || []) {
    if (String(sub.deliveryMode?.address || '').includes('/api/rc-sms')) await rc(token, `/restapi/v1.0/subscription/${sub.id}`, { method: 'DELETE' });
  }
  const r = await rc(token, '/restapi/v1.0/subscription', { method: 'POST', body: JSON.stringify({ eventFilters: filters, deliveryMode: { transportType: 'WebHook', address: SMS_ADDRESS() }, expiresIn }) });
  if (r.ok) await saveSmsSub(r.json?.id);
  const smsRows = rows.filter((x) => x.sms);
  return {
    ok: r.ok, id: r.json?.id, status: r.json?.status, expirationTime: r.json?.expirationTime, filters: filters.length, disabledFilters: r.json?.disabledFilters || [],
    error: r.ok ? null : (r.json?.message || `HTTP ${r.status}`),
    numbers: smsRows.map((x) => ({ number: x.e164, ext: x.extension_number, name: x.extension_name, usage: x.usage_type, branch: x.branch, agent: x.agent_email })),
    unmapped: smsRows.filter((x) => !x.branch && !x.agent_email).map((x) => x.e164 + ' ' + (x.extension_name || '')),
    no_extension: smsRows.filter((x) => !x.extension_id).map((x) => x.e164 + ' (' + (x.usage_type || '') + ') - no message store to subscribe to; assign it to a user or queue in RingCentral'),
  };
}
async function smsRenew(token) {
  const list = await rc(token, '/restapi/v1.0/subscription');
  const mine = ((list.json && list.json.records) || []).filter((sub) => String(sub.deliveryMode?.address || '').includes('/api/rc-sms'));
  if (!mine.length) return { ok: false, note: 'no SMS subscription - run action=sms_create' };
  let rows = null; try { rows = await refreshNumbers(token); } catch (e) { /* keep the old filters if the refresh failed */ }
  const out = [];
  for (const sub of mine) {
    const filters = rows ? smsFilters(rows) : sub.eventFilters;
    const r = await rc(token, `/restapi/v1.0/subscription/${sub.id}`, { method: 'PUT', body: JSON.stringify({ eventFilters: filters, expiresIn }) });
    out.push({ id: sub.id, ok: r.ok, expirationTime: r.json?.expirationTime, filters: filters.length, disabledFilters: r.json?.disabledFilters || [] });
  }
  return { ok: out.every((x) => x.ok), renewed: out };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Two callers: Saif with the admin key, and Vercel Cron. The repo is public,
  // so the cron cannot carry a token in vercel.json — Vercel sends
  // `Authorization: Bearer $CRON_SECRET` instead when that env var exists.
  const admin = process.env.ADMIN_API_KEY;
  const supplied = String(
    (req.query && req.query.token) || req.headers['x-admin-key'] || ''
  );
  const byAdmin = admin && supplied === admin;

  const cronSecret = process.env.CRON_SECRET;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const byCron = cronSecret && bearer === cronSecret;

  if (!byAdmin && !byCron) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing token' });
  }

  for (const v of ['RC_CLIENT_ID', 'RC_CLIENT_SECRET', 'RC_JWT', 'RC_WEBHOOK_TOKEN']) {
    if (!process.env[v]) {
      return res.status(500).json({ ok: false, error: `Missing env var ${v}` });
    }
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message });
  }

  const action = String((req.query && req.query.action) || '').toLowerCase();

  // ---- list -------------------------------------------------------------
  if (!action) {
    const r = await rc(token, '/restapi/v1.0/subscription');
    const subs = (r.json && r.json.records) || [];
    return res.status(200).json({
      ok: r.ok,
      callbackUrl: callbackUrl().replace(/token=[^&]*/, 'token=***'),
      count: subs.length,
      subscriptions: subs.map((s) => ({
        id: s.id,
        status: s.status,
        expirationTime: s.expirationTime,
        eventFilters: s.eventFilters,
        disabledFilters: s.disabledFilters || [],
        address: (s.deliveryMode && s.deliveryMode.address || '').replace(/token=[^&]*/, 'token=***'),
      })),
    });
  }

  // ---- SMS subscription (Sep 17) ------------------------------------------
  if (action === 'sms_create') {
    try { return res.status(200).json(await smsCreate(token)); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  }
  if (action === 'numbers') {
    try { const rows = await refreshNumbers(token); return res.status(200).json({ ok: true, count: rows.length, sms: rows.filter((x) => x.sms).length, numbers: rows.map((x) => ({ number: x.e164, ext: x.extension_number, name: x.extension_name, usage: x.usage_type, sms: x.sms, branch: x.branch, agent: x.agent_email })) }); }
    catch (e) { return res.status(502).json({ ok: false, error: e.message }); }
  }

  // ---- delete -----------------------------------------------------------
  if (action === 'delete') {
    const id = String((req.query && req.query.id) || '');
    if (!id) return res.status(400).json({ ok: false, error: 'Missing ?id=' });
    const r = await rc(token, `/restapi/v1.0/subscription/${id}`, { method: 'DELETE' });
    return res.status(r.ok ? 200 : r.status).json({ ok: r.ok, deleted: id });
  }

  // ---- renew ------------------------------------------------------------
  if (action === 'renew') {
    const list = await rc(token, '/restapi/v1.0/subscription');
    const mine = ((list.json && list.json.records) || []).filter((s) =>
      String(s.deliveryMode?.address || '').includes('/api/rc-webhook')
    );
    if (!mine.length) {
      const created = await rc(token, '/restapi/v1.0/subscription', {
        method: 'POST',
        body: JSON.stringify({
          eventFilters: EVENT_FILTERS,
          deliveryMode: { transportType: 'WebHook', address: callbackUrl() },
          expiresIn,
        }),
      });
      return res.status(created.ok ? 200 : created.status).json({
        ok: created.ok,
        recreated: true,
        note: 'No live subscription found — created a new one.',
        id: created.json?.id,
        expirationTime: created.json?.expirationTime,
        disabledFilters: created.json?.disabledFilters || [],
      });
    }
    const out = [];
    for (const s of mine) {
      const r = await rc(token, `/restapi/v1.0/subscription/${s.id}`, {
        method: 'PUT',
        body: JSON.stringify({ eventFilters: EVENT_FILTERS, expiresIn }),
      });
      out.push({
        id: s.id,
        ok: r.ok,
        expirationTime: r.json?.expirationTime,
        disabledFilters: r.json?.disabledFilters || [],
      });
    }
    /* the SMS subscription renews on the same cron, but on its own: a failure here is reported, never thrown */
    let sms = null; try { sms = await smsRenew(token); } catch (e) { sms = { ok: false, error: e.message }; }
    return res.status(200).json({ ok: true, renewed: out, sms });
  }

  // ---- create -----------------------------------------------------------
  if (action === 'create') {
    // Clear any prior subscription pointing at this endpoint so we don't
    // accumulate duplicates and double-write every event.
    const list = await rc(token, '/restapi/v1.0/subscription');
    for (const s of (list.json && list.json.records) || []) {
      if (String(s.deliveryMode?.address || '').includes('/api/rc-webhook')) {
        await rc(token, `/restapi/v1.0/subscription/${s.id}`, { method: 'DELETE' });
      }
    }

    const r = await rc(token, '/restapi/v1.0/subscription', {
      method: 'POST',
      body: JSON.stringify({
        eventFilters: EVENT_FILTERS,
        deliveryMode: { transportType: 'WebHook', address: callbackUrl() },
        expiresIn,
      }),
    });

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: r.json?.message || r.text?.slice(0, 400) || `HTTP ${r.status}`,
        hint: 'Check the callback URL is publicly reachable and returns the Validation-Token header.',
      });
    }

    const disabled = r.json?.disabledFilters || [];
    return res.status(200).json({
      ok: true,
      id: r.json?.id,
      status: r.json?.status,
      expirationTime: r.json?.expirationTime,
      eventFilters: r.json?.eventFilters,
      disabledFilters: disabled,
      warning: disabled.length
        ? 'One or more filters were DISABLED — events will not arrive. Usually a missing app permission.'
        : null,
    });
  }

  return res.status(400).json({ ok: false, error: `Unknown action "${action}"` });
}

/* for the harness: the mapping decides which threads are private mirrors */
export { refreshNumbers, smsFilters };
