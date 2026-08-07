// /api/rc-subscribe — manage the RingCentral webhook subscription.
//
// Subscriptions expire (7 days max) and RingCentral disables one after repeated
// delivery failures. This endpoint is how we create, inspect and renew it.
//
//   GET  /api/rc-subscribe?token=<ADMIN_API_KEY>              -> list current subscriptions
//   POST /api/rc-subscribe?token=<ADMIN_API_KEY>&action=create -> create/replace
//   POST /api/rc-subscribe?token=<ADMIN_API_KEY>&action=renew  -> extend expiry
//   POST /api/rc-subscribe?token=<ADMIN_API_KEY>&action=delete&id=<subId>
//
// IMPORTANT: after creating, always read `disabledFilters` in the response.
// A missing permission shows up there, not as an error — the subscription is
// created successfully and then silently delivers nothing.

const RC_BASE = () =>
  (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');

// Account-wide: every extension across all four branches.
const EVENT_FILTERS = ['/restapi/v1.0/account/~/telephony/sessions'];

async function getAccessToken() {
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
  if (!r.ok) throw new Error(`auth HTTP ${r.status}: ${j.error_description || j.error || ''}`);
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const admin = process.env.ADMIN_API_KEY;
  const supplied = String(
    (req.query && req.query.token) || req.headers['x-admin-key'] || ''
  );
  if (!admin || supplied !== admin) {
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
  if (req.method === 'GET' || !action) {
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
      return res.status(404).json({ ok: false, error: 'No matching subscription to renew' });
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
    return res.status(200).json({ ok: true, renewed: out });
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
