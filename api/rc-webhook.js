// /api/rc-webhook — RingCentral telephony session events -> Supabase call_log.
//
// RingCentral POSTs here every time a call changes state (ringing, answered,
// disconnected). We write a row on the FIRST event and patch that same row as
// the call progresses — same safety pattern as bridge_ledger: the record exists
// before any downstream step can fail.
//
// Two jobs:
//   1. Validation handshake. On subscription creation RingCentral POSTs with a
//      Validation-Token header; we must echo it back or the webhook never
//      activates.
//   2. Event ingest. Upsert on (rc_session_id, rc_party_id).
//
// Auth: ?token=<RC_WEBHOOK_TOKEN>. RingCentral has no request signing, so the
// shared secret in the callback URL is the gate.

const OFFICE_BY_EXT = {
  107: 1, 109: 1, 110: 1, 108: 1,          // Moreno Valley
  105: 2, 103: 2, 104: 2,                   // Riverside — Van Buren
  113: 3, 11: 3, 114: 3,                    // Riverside — Magnolia
  115: 4,                                   // Lake Elsinore
};

const digits10 = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
};

const sbEnv = () => ({
  url: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, ''),
  key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
});

// ---- RingCentral auth (JWT -> access token, cached in module scope) ---------

let tokenCache = { value: null, expires: 0 };

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;

  const base = (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
  const basic = Buffer.from(`${process.env.RC_CLIENT_ID}:${process.env.RC_CLIENT_SECRET}`).toString('base64');

  const r = await fetch(`${base}/restapi/oauth/token`, {
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

  if (!r.ok) throw new Error(`RC auth failed: HTTP ${r.status}`);
  const j = await r.json();
  tokenCache = {
    value: j.access_token,
    expires: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000,
  };
  return tokenCache.value;
}

// ---- Extension directory (RC internal id -> ext number, name, email) --------
// The webhook payload carries RingCentral's internal extensionId, not the
// dialable extension. Cached for an hour; the directory rarely changes.

let extCache = { map: null, expires: 0 };

async function getExtensionMap() {
  if (extCache.map && Date.now() < extCache.expires) return extCache.map;

  try {
    const base = (process.env.RC_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
    const token = await getAccessToken();
    const r = await fetch(`${base}/restapi/v1.0/account/~/extension?perPage=1000&type=User`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();

    const map = {};
    for (const e of j.records || []) {
      map[String(e.id)] = {
        ext: e.extensionNumber || null,
        name: e.name || [e.contact?.firstName, e.contact?.lastName].filter(Boolean).join(' ') || null,
        email: e.contact?.email || null,
      };
    }
    extCache = { map, expires: Date.now() + 60 * 60 * 1000 };
    return map;
  } catch {
    return extCache.map || {};
  }
}

// ---- Event shaping ---------------------------------------------------------

function resultFrom(status) {
  const code = status?.code;
  const reason = status?.reason;
  if (code === 'Answered') return 'Answered';
  if (code === 'VoiceMail') return 'Voicemail';
  if (code !== 'Disconnected') return null;          // still in progress
  if (reason === 'Voicemail') return 'Voicemail';
  if (reason === 'Busy') return 'Busy';
  if (reason === 'Rejected' || reason === 'Declined') return 'Rejected';
  if (reason === 'NoAnswer' || reason === 'NotAllowed') return 'Missed';
  return 'Answered';
}

function shape(body, party, extMap) {
  const now = body.eventTime || new Date().toISOString();
  const dir = party.direction || null;
  const fromRaw = party.from?.phoneNumber || party.from?.extensionNumber || null;
  const toRaw = party.to?.phoneNumber || party.to?.extensionNumber || null;

  const info = party.extensionId ? extMap[String(party.extensionId)] : null;
  const extNum = info?.ext ? Number(info.ext) : null;

  const row = {
    rc_session_id: String(body.telephonySessionId || body.sessionId || ''),
    rc_party_id: String(party.id || ''),
    direction: dir,
    from_raw: fromRaw,
    to_raw: toRaw,
    from_number: digits10(fromRaw),
    to_number: digits10(toRaw),
    extension_id: party.extensionId ? String(party.extensionId) : null,
    agent_name: info?.name || null,
    agent_email: info?.email || null,
    office_id: extNum && OFFICE_BY_EXT[extNum] != null ? OFFICE_BY_EXT[extNum] : null,
    raw_event: body,
  };

  const code = party.status?.code;
  if (code === 'Setup' || code === 'Proceeding') row.started_at = now;
  if (code === 'Answered') row.answered_at = now;
  if (code === 'Disconnected' || code === 'Gone') row.ended_at = now;

  const result = resultFrom(party.status);
  if (result) row.result = result;
  if (party.missedCall === true) row.result = 'Missed';

  return row;
}

// The caller is whichever leg is external. On an inbound call that's `from`,
// on an outbound call it's `to`.
const callerNumber = (row) =>
  row.direction === 'Outbound' ? row.to_number : row.from_number;

// ---- Supabase --------------------------------------------------------------

async function matchClient(phone10) {
  if (!phone10) return null;
  const { url, key } = sbEnv();
  if (!url || !key) return null;
  try {
    const r = await fetch(
      `${url}/rest/v1/client_phone_index?phone10=eq.${phone10}&select=client_number,display_name,office_id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

async function upsert(row) {
  const { url, key } = sbEnv();
  if (!url || !key) throw new Error('SUPABASE env vars missing');

  const r = await fetch(`${url}/rest/v1/call_log?on_conflict=rc_session_id,rc_party_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Supabase upsert HTTP ${r.status} ${detail.slice(0, 300)}`);
  }
}

// ---- Handler ---------------------------------------------------------------

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // 1. Validation handshake. Must come before auth — RingCentral does not send
  //    our token on the verification POST. Echo the header, return 200, done.
  const validation = req.headers['validation-token'];
  if (validation) {
    res.setHeader('Validation-Token', validation);
    return res.status(200).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  // 2. Shared-secret gate.
  const expected = process.env.RC_WEBHOOK_TOKEN;
  const supplied = String((req.query && req.query.token) || '');
  if (!expected || supplied !== expected) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing token' });
  }

  // 3. Always 200 to RingCentral. They disable a webhook after repeated
  //    non-2xx responses, and losing the subscription is worse than losing a
  //    single event. Failures are logged, not surfaced.
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }

  const body = payload && payload.body;
  if (!body || !Array.isArray(body.parties)) {
    return res.status(200).json({ ok: true, skipped: 'no parties in payload' });
  }

  const extMap = await getExtensionMap();
  let written = 0;

  for (const party of body.parties) {
    try {
      const row = shape(body, party, extMap);
      if (!row.rc_session_id) continue;

      const client = await matchClient(callerNumber(row));
      if (client) {
        row.client_number = client.client_number;
        row.matched = true;
        if (row.office_id == null && client.office_id != null) row.office_id = client.office_id;
      }

      // duration_seconds and updated_at are set by a database trigger —
      // answered_at and ended_at arrive in separate events, so they can never
      // both be present in a single shaped row.
      await upsert(row);
      written += 1;
    } catch (e) {
      console.error('[rc-webhook] party failed:', e.message);
    }
  }

  return res.status(200).json({ ok: true, written });
}
