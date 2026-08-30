export const config = { maxDuration: 30, api: { bodyParser: { sizeLimit: '12mb' } } };
import { gzipSync } from 'node:zlib';
// /api/carrier — Phase 1: capture the carrier-payment leg + required receipt for a completed client payment.
// POST actions: save_carrier_leg (with base64 receipt) -> Blob + attachments + HawkSoft file + ledger lifecycle.
// Auth: Google ID token, allowlist. Reads/writes only our tables + files the receipt to the client's HawkSoft record.

const GOOGLE_CLIENT_ID = '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const ADMIN_ALLOWLIST = ['info@speedyins.com'];
// Agents must be able to file proof for their OWN payments. Previously only info@
// could, so every agent was locked out of the audit step — which is why 38 charges
// sat unaudited. Agents are scoped to their own ledger rows below; admin sees all.
const AGENT_ALLOWLIST = [
  'sammy@speedyins.com', 'yolanda@speedyins.com', 'jorge@speedyins.com', 'lfigueroa@speedyins.com',
  'chris@speedyins.com', 'yasmin@speedyins.com', 'fernando@speedyins.com', 'jesus@speedyins.com',
  'alejandra@speedyins.com', 'esmeralda@speedyins.com', 'irene@speedyins.com',
  'malcolm@speedyins.com', 'melisa@speedyins.com',
  'tony@speedyins.com', 'lana@speedyins.com',
];
const ALLOWLIST = ADMIN_ALLOWLIST;
const AGENCY_ID = 15112;
const HS_BASE = 'https://integration.hawksoft.app';

/* Verified-claims cache.
   The tokeninfo round trip to Google ran on EVERY request - client search fires
   one per keystroke. This remembers Google's answer briefly, keyed by the token.

   Three rules make it safe:
   1. It caches CLAIMS (who Google says this is), never an authorization decision.
      Every caller still applies its own allowlist on the result, so a token
      verified for one endpoint cannot inherit another endpoint's permissions.
   2. An entry NEVER outlives the token itself - ttl is capped by the token's own
      exp claim. A token with 10s left is cached for 10s, not 60.
   3. Failures are never cached. A rejected token is re-checked every time, so
      fixing an allowlist or revoking access takes effect immediately. */
const _claimsCache = new Map();
const CLAIMS_TTL_MS = 60000;

async function googleClaims(idToken) {
  if (!idToken) return null;
  const hit = _claimsCache.get(idToken);
  if (hit) {
    if (hit.until > Date.now()) return hit.claims;
    _claimsCache.delete(idToken);
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (r.status !== 200) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    if (!email) return null;
    const expMs = Number(t.exp) * 1000;
    const ttl = Math.min(CLAIMS_TTL_MS, (expMs || 0) - Date.now());
    const claims = { email };
    if (ttl > 0) {
      if (_claimsCache.size > 500) _claimsCache.clear();
      _claimsCache.set(idToken, { claims, until: Date.now() + ttl });
    }
    return claims;
  } catch { return null; }
}

async function verifyGoogle(idToken) {
  const cl = await googleClaims(idToken);
  if (!cl) return null;
  if (ADMIN_ALLOWLIST.includes(cl.email)) return cl.email;
  if (AGENT_ALLOWLIST.includes(cl.email)) return cl.email;
  return null;
}

function isAdmin(email) { return ADMIN_ALLOWLIST.includes(String(email || '').toLowerCase()); }

/* An agent may only file proof against a payment they took. Admin may file against any.
   Without this, opening the allowlist would let any agent edit anyone's payment. */
async function mayTouchPayment(s, email, paymentId) {
  if (isAdmin(email)) return true;
  if (!paymentId) return true; // no ledger row to guard (document-only upload)
  try {
    const r = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(paymentId)}&select=agent`);
    const row = (r.rows || [])[0];
    if (!row) return true;
    return String(row.agent || '').toLowerCase().includes(String(email).toLowerCase());
  } catch { return false; }
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

async function sbGet(s, path) {
  try {
    const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs });
    const rows = await r.json().catch(() => []);
    return { rows: Array.isArray(rows) ? rows : [] };
  } catch { return { rows: [] }; }
}

/* ---------- Resolve the policy a document belongs to — SERVER SIDE ----------
   Every document ever uploaded filed at CLIENT level (Pol 0) because this API
   trusted the page to hand it a GUID and the page always sent an empty string:
   charge.html read `c.policyGuid || c.policyId`, and NOTHING in charge.html ever
   wrote either key. 0 of 107 attachments carried a policy. The charge path was
   never affected — api/hawksoft.js resolves the policy itself, which is exactly
   what this does now.

   Order: trust a real GUID from the page, else the ledger row, else look it up.
   FAIL-SOFT: any miss returns null and the caller omits PolicyId, which is
   today's behaviour. This can make filing better, never worse.

   The single-match rule is deliberate. Client 16810 has two records numbered
   4CQF020; filing on the wrong policy is worse than filing at client level. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolvePolicyGuid(s, { policy_guid, client_no, payment_id, policy_num }) {
  try {
    if (policy_guid && UUID_RE.test(String(policy_guid).trim())) {
      return { guid: String(policy_guid).trim(), via: 'page' };
    }
    if (!s || !client_no) return { guid: null, via: 'no_client' };

    let num = (policy_num || '').toString().trim();

    /* The ledger row already holds both. Cash charges store policyGuid; card
       charges store only policyNumber. Read whichever is there. */
    if (payment_id) {
      const r = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(payment_id)}`
        + `&select=policy_guid:extra->>policyGuid,policy_number:extra->>policyNumber`);
      const row = (r.rows || [])[0] || {};
      if (row.policy_guid && UUID_RE.test(String(row.policy_guid).trim())) {
        return { guid: String(row.policy_guid).trim(), via: 'ledger_guid' };
      }
      if (!num && row.policy_number) num = String(row.policy_number).trim();
    }
    if (!num) return { guid: null, via: 'no_policy_number' };

    const q = await sbGet(s, `policies?client_no=eq.${encodeURIComponent(client_no)}`
      + `&select=policy_number,hs_policy_guid`);
    const want = num.toUpperCase();
    const hits = (q.rows || []).filter(p =>
      String(p.policy_number || '').trim().toUpperCase() === want && p.hs_policy_guid);

    if (hits.length === 1) return { guid: hits[0].hs_policy_guid, via: 'lookup' };
    if (hits.length > 1) return { guid: null, via: 'ambiguous' };
    return { guid: null, via: 'not_found' };
  } catch { return { guid: null, via: 'error' }; }
}

/* ---------- Document bytes live in Supabase Storage, not in Postgres ----------
   SECURITY. The bucket `client-documents` is PRIVATE (public=false), so no
   anonymous URL can ever read it. These are driver licenses, dec pages, ID cards
   and signed applications - DOB, license numbers, VINs. Reads go through
   portal_doc, which already sits behind Google SSO plus the agent allowlist, and
   that stays the ONLY door: we never mint a signed URL and never hand the browser
   a path, because a signed URL works for anyone holding it until it expires.

   WHY NOT VERCEL BLOB. Supabase Pro already includes 100 GB of file storage we do
   not use, the service-role key is already in the environment (no new credential,
   no waiting on an env var to reach a deployment), and public Vercel blob URLs are
   "unique and hard to guess", which is obscurity rather than access control.

   PERFORMANCE. Postgres stops carrying file bytes. `blob_url` holds an object PATH
   here, never a public URL. Thumbnails stay inline in `thumb_b64` on purpose - they
   are tiny and the client card renders many at once, so fetching each from storage
   would turn one list render into N round trips. */
const DOC_BUCKET = 'client-documents';

function docStorage() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), key };
}

/* Returns the stored PATH, never a URL. Fail-soft by construction: on any failure
   the caller keeps the inline copy, so a document can never be lost by trying. */
async function storagePut(objectPath, buf, contentType, upsert) {
  const st = docStorage();
  if (!st) return { path: null, status: 'no_supabase_env' };
  if (!buf || !buf.length) return { path: null, status: 'empty' };
  if (buf.length > 5 * 1024 * 1024) return { path: null, status: 'too_large' };
  try {
    const r = await fetch(`${st.base}/storage/v1/object/${DOC_BUCKET}/${objectPath}`, {
      method: 'POST',
      headers: {
        apikey: st.key, Authorization: `Bearer ${st.key}`,
        'Content-Type': contentType || 'application/octet-stream',
        'cache-control': 'max-age=31536000', 'x-upsert': upsert ? 'true' : 'false',
      },
      body: buf,
    });
    if (r.status !== 200) {
      const t = await r.text().catch(() => '');
      return { path: null, status: 'http_' + r.status, err: t.slice(0, 160) };
    }
    return { path: objectPath, status: 'ok' };
  } catch (e) { return { path: null, status: 'error', err: String(e).slice(0, 160) }; }
}

/* One object name per upload. crypto.randomUUID keeps it unguessable and makes a
   collision impossible; the client folder makes the store readable by a human
   during an incident. The extension is whitelisted, never taken from user input
   verbatim, so nothing can be written outside the bucket. */
/* Same shape as docObjectPath but keyed on the attachment id, so re-running the
   migration overwrites rather than duplicates. */
function migrateObjectPath(attId, clientNo, filename, mime) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const safe = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'eml'].includes(ext)
    ? ext : (String(mime || '').includes('pdf') ? 'pdf' : 'bin');
  const cn = String(parseInt(clientNo, 10) || 0);
  return `${cn}/${String(attId).replace(/[^0-9a-f-]/gi, '')}.${safe}`;
}

function docObjectPath(clientNo, filename, mime) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const safe = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'eml'].includes(ext)
    ? ext : (String(mime || '').includes('pdf') ? 'pdf' : 'bin');
  const cn = String(parseInt(clientNo, 10) || 0);
  return `${cn}/${crypto.randomUUID()}.${safe}`;
}

async function sha256hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBuf(b64) {
  const clean = String(b64).replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(clean, 'base64');
}
const b64h = s => Buffer.from(String(s), 'utf8').toString('base64');


async function hsCreateTask(clientNo, title, description, taskEmail) {
  const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
  if (!ID || !SECRET) return { ok: false, refid: null };
  const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const refId = crypto.randomUUID();
  const now = new Date();
  const receipt = [{
    channel: 32,
    logNote: `Audit task: ${title}`,
    task: {
      title: String(title).slice(0, 80),
      description: String(description).slice(0, 500),
      dueDate: new Date(now.getTime() + 72 * 3600 * 1000).toISOString(),
      ...(taskEmail ? { specifiedUser: { email: taskEmail } } : {}),
    },
  }];
  try {
    const r = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${clientNo}/receipts?version=4.0`, {
      method: 'POST', headers: { Authorization: AUTH, 'Content-Type': 'application/json', RefId: refId },
      body: JSON.stringify(receipt),
    });
    return { ok: r.status === 200 || r.status === 202, refid: refId, status: r.status };
  } catch { return { ok: false, refid: refId }; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const email = await verifyGoogle(req.headers['x-id-token']);
  if (!email) return res.status(401).json({ ok: false, error: 'Not authorized' });

  const s = sb();
  if (!s) return res.status(500).json({ ok: false, error: 'Supabase not configured' });

  let body = {}; try { body = req.body || {}; } catch {}
  const action = body.action || '';

  /* Carrier list for the "Carrier paid" dropdown.
     This field was free text. Thirteen audits produced ASPIRE / Aspire General /
     "Aspire General Insurance Services", ONWARD INS / ONWARD INSURANCE, Bluefire
     against a book that says BLUE FIRE, and one policy number pasted into the box.
     You cannot total carrier payments when one carrier has three spellings.

     The list is derived from the policy book, so it maintains itself — a carrier
     the agency starts writing appears here once its first policy syncs. Nothing
     for an agent to maintain, nothing to go stale.

     Cheap by construction: names only, no client or policy rows, and the result is
     small enough to send whole. */
  if (action === 'carrier_list') {
    const client_no = parseInt(body.client_no, 10) || null;

    /* What the charge already knew. hawksoft.js resolves the policy's carrier and
       program at charge time; both are now recorded on the ledger row, so the audit
       step can prefill instead of asking the agent to retype what we already have.
       Read from the payment rather than the URL so a link saved by "finish later"
       still prefills correctly. */
    let suggested = null, program = null, purpose = null;
    if (body.payment_id) {
      const p = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(body.payment_id)}&select=extra,carrier_name,purpose`);
      const row = p.rows && p.rows[0];
      if (row) {
        const ex = row.extra || {};
        suggested = row.carrier_name || ex.policyCarrier || (ex.hawksoft && ex.hawksoft.policyCarrier) || null;
        program   = ex.policyProgram || (ex.hawksoft && ex.hawksoft.policyProgram) || null;
        purpose   = row.purpose || null;
      }
    }

    // carriers already on this client's policies go to the top — nearly always the answer
    let mine = [];
    if (client_no) {
      const r = await sbGet(s, `policies?client_no=eq.${client_no}&select=carrier&carrier=not.is.null&limit=50`);
      mine = [...new Set((r.rows || []).map(x => String(x.carrier || '').trim()).filter(Boolean))];
    }

    // carrier_directory is a view that does the grouping in Postgres. Counting in JS
    // here would mean pulling ~46,000 policy rows over the wire on every page load;
    // this is 178 short rows, about 5 KB.
    const all = await sbGet(s, 'carrier_directory?select=name,policies&order=policies.desc&limit=400');
    const ranked = (all.rows || [])
      .map(r => ({ name: String(r.name || '').trim(), policies: r.policies }))
      .filter(x => x.name && mine.indexOf(x.name) === -1);

    return res.status(200).json({ ok: true, suggested, program, purpose, onThisClient: mine, carriers: ranked });
  }

  /* ---------- Storage reachability probe (admin only) ----------
     Writes one tiny object into the private client-documents bucket and reports
     what came back. Reads no client data and writes no attachment row. Kept
     because the failure modes are silent otherwise: storagePut returns a status
     that only the caller sees, so without this a broken write looks identical to
     a working one from the outside. */
  if (action === 'blob_probe') {
    if (!isAdmin(email)) return res.status(403).json({ ok: false, error: 'admin only' });
    const r = await storagePut(`0/probe_${crypto.randomUUID()}.pdf`, Buffer.from('%PDF-1.4 probe'), 'application/pdf');
    return res.status(200).json({
      ok: r.status === 'ok', bucket: DOC_BUCKET, result: r,
      meaning: r.status === 'ok' ? 'Private bucket is writable. Uploads are off Postgres.'
             : r.status === 'no_supabase_env' ? 'SUPABASE_URL / service key missing on this deployment.'
             : 'Write refused - see result.status and result.err.',
    });
  }

  /* ---------- One-time migration of the inline documents (admin only) ----------
     212 files predate the bucket and live as base64 in Postgres. This copies them
     across in batches and records the object path; the inline copy is NOT touched,
     so this is additive and can be re-run safely. Rows that already have a path are
     skipped, so a partial run simply resumes.

     Batched because a serverless function has a time limit and 28 MB in one request
     would not finish. Each row is verified by reading it back out of the bucket and
     comparing the byte length before the path is recorded - a path written for an
     object that is not really there would be worse than no path at all. */
  if (action === 'doc_migrate') {
    if (!isAdmin(email)) return res.status(403).json({ ok: false, error: 'admin only' });
    /* Small batches. Each row is an upload AND a read-back, files run to 3 MB, and
       a serverless function has a time limit - at 25 it died mid-batch, leaving the
       objects written and the rows unrecorded. */
    const limit = Math.min(parseInt(body.limit, 10) || 8, 15);
    const st = docStorage();
    if (!st) return res.status(500).json({ ok: false, error: 'no supabase env' });

    const todo = await sbGet(s, `attachments?blob_url=is.null&file_b64=not.is.null`
      + `&select=id,client_no,filename,mime,bytes,file_b64&order=created_at.asc&limit=${limit}`);
    const rows = todo.rows || [];
    const out = { moved: 0, verified: 0, skipped: 0, failed: [], remaining: null };

    for (const a of rows) {
      try {
        const buf = b64ToBuf(a.file_b64);
        if (!buf || !buf.length) { out.skipped++; continue; }
        /* DETERMINISTIC path, keyed on the attachment id, and upsert. The live
           upload path uses a random uuid because each upload is genuinely new; a
           migration retry is the SAME file and must land on the SAME object.
           Random names made every retry orphan its predecessor - 118 of them. The
           id is itself a uuid, so this is no more guessable, and the bucket is
           private either way. */
        const path = migrateObjectPath(a.id, a.client_no, a.filename, a.mime);
        const put = await storagePut(path, buf, a.mime || 'application/pdf', true);
        if (put.status !== 'ok') { out.failed.push({ id: a.id, why: put.status, err: put.err || null }); continue; }

        // read it back before trusting it
        const check = await fetch(`${st.base}/storage/v1/object/${DOC_BUCKET}/${path}`,
          { headers: { apikey: st.key, Authorization: `Bearer ${st.key}` } });
        const ok = check.status === 200
          && Buffer.from(await check.arrayBuffer()).length === buf.length;
        if (!ok) { out.failed.push({ id: a.id, why: 'verify_failed' }); continue; }
        out.verified++;

        await fetch(`${s.base}/rest/v1/attachments?id=eq.${a.id}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ blob_url: path }),
        });
        out.moved++;
      } catch (e) { out.failed.push({ id: a.id, why: String(e).slice(0, 120) }); }
    }

    const left = await sbGet(s, `attachments?blob_url=is.null&file_b64=not.is.null&select=id`);
    out.remaining = (left.rows || []).length;
    return res.status(200).json({ ok: true, ...out,
      note: out.remaining ? 'Run again to continue.' : 'All inline documents are now in the bucket. Inline copies kept.' });
  }

  /* Delete objects in the bucket that no attachment row points at. Created by the
     first migration attempt, which used random names and timed out mid-batch, so
     the same row uploaded a fresh object on every retry. Only ever removes objects
     NOT referenced by any row, and never touches file_b64, so no document can be
     lost by running it. */
  if (action === 'doc_orphans') {
    if (!isAdmin(email)) return res.status(403).json({ ok: false, error: 'admin only' });
    const st = docStorage();
    if (!st) return res.status(500).json({ ok: false, error: 'no supabase env' });
    const dry = body.delete !== true;

    const listed = await fetch(`${s.base}/rest/v1/rpc/list_orphan_document_objects`, {
      method: 'POST', headers: { ...s.hdrs }, body: JSON.stringify({}),
    });
    const names = await listed.json().catch(() => []);
    const paths = Array.isArray(names) ? names.map(x => x.name || x).filter(Boolean) : [];
    if (dry) return res.status(200).json({ ok: true, dry_run: true, orphans: paths.length, sample: paths.slice(0, 5) });

    let deleted = 0, failed = 0;
    for (const p of paths.slice(0, 200)) {
      const d = await fetch(`${st.base}/storage/v1/object/${DOC_BUCKET}/${p}`,
        { method: 'DELETE', headers: { apikey: st.key, Authorization: `Bearer ${st.key}` } });
      if (d.status === 200) deleted++; else failed++;
    }
    return res.status(200).json({ ok: true, deleted, failed, remaining_after: paths.length - deleted });
  }

  if (action === 'add_document') {
    // Lightweight: just store a supporting document (no ledger/carrier logic)
    const { client_no, policy_id, policy_guid, doc_type, doc_label, receipt_b64, receipt_name, receipt_mime } = body;
    /* When the agent chose document type "Other" they were asked what it is.
       Use their words — "other" tells nobody anything six months later.
       Declared HERE, above both readers (the attachments insert and the HawkSoft
       Desc). It was written 18 lines below its first use and would have thrown a
       ReferenceError on the first upload. HawkSoft caps Desc at 41 characters;
       the page counts to 41 so the slice below should never actually bite. */
    const label = String(doc_label || '').trim();
    let payment_id = body.payment_id;
    /* A document attached to a POLICY has no payment behind it - an ID card or a
       dec page is not proof of anything financial. The lookup below exists for the
       audit flow, where a document arriving without a payment_id almost certainly
       belongs to the one open payment. Applied here it would staple an ID card to
       an unrelated charge, where it would then show under that payment's chips and
       read as its proof. The caller says which case it is; we do not guess. */
    if (body.no_payment === true) payment_id = null;
    else if (!payment_id && client_no) {
      const open = await sbGet(s, `bridge_ledger?client_id=eq.${client_no}`
        + `&audit_status=in.(client_paid,carrier_pending)&is_test=is.false`
        + `&select=id&order=ts.desc&limit=2`);
      if ((open.rows || []).length === 1) payment_id = open.rows[0].id;
    }
    if (!client_no || !receipt_b64) return res.status(400).json({ ok: false, error: 'client_no + file required' });

    /* Any agent may ADD a document to any payment (Saif, Aug 24). Adding paperwork
       is follow-up finishing, not a money change: this branch never touches
       commission_to, fee_amount or audit_status. `uploaded_by` records who did it
       and the portal shows that name on every chip, which is what keeps it honest.
       save_carrier_leg — which DOES move money — keeps mayTouchPayment below. */

    /* Which policy does this belong to? Resolved here, server-side. */
    const pol = await resolvePolicyGuid(s, {
      policy_guid, client_no, payment_id, policy_num: body.policy_num,
    });

    const buf = b64ToBuf(receipt_b64);
    const hash = await sha256hex(buf);
    const ext = (receipt_name || '').split('.').pop() || (String(receipt_mime).includes('pdf') ? 'pdf' : 'png');
    const dtype = doc_type || 'other';
    const today = new Date().toISOString().slice(0,10);
    const looksUuid = /^[0-9a-f-]{30,}\.[a-z]+$/i.test(receipt_name || '');
    const niceName = (receipt_name && !looksUuid) ? receipt_name : `${dtype}_${client_no}_${today}.${ext}`;

    /* This path stored bytes ONLY in Postgres - the storage helper was never
       called here at all, only from save_carrier_leg. Both now write to the same
       private bucket. */
    const putDoc = await storagePut(docObjectPath(client_no, niceName, receipt_mime), buf, receipt_mime || 'application/pdf');

    const attIns = await fetch(`${s.base}/rest/v1/attachments`, {
      method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' },
      body: JSON.stringify([{
        client_no,
        policy_id: pol.guid || (UUID_RE.test(String(policy_id || '')) ? policy_id : null),
        payment_id: payment_id || null,
        kind: dtype, doc_type: dtype, doc_label: label || null, filename: niceName,
        blob_url: putDoc.path,
        /* DUAL WRITE, deliberately. The inline copy stays until documents have been
           read from storage for a month. Dropping it now would mean trusting a path
           that has never served a single file. */
        file_b64: receipt_b64, thumb_b64: body.thumb_b64 || null,
        sha256: hash, mime: receipt_mime, bytes: buf.length,
        uploaded_by: email,
      }]),
    });
    const attachment = (await attIns.json().catch(() => []))[0] || null;

    // File to HawkSoft too (gzip, same as receipts)
    let hsFiled = false, hsRefId = null;
    const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
    if (ID && SECRET) {
      const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
      hsRefId = crypto.randomUUID();
      const fname = niceName.replace(/\.[^.]+$/, '').slice(0, 60);
      const desc = (label || dtype.replace(/_/g,' ')).slice(0, 41);
      try {
        const r2 = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${client_no}/attachment?version=4.0`, {
          method: 'POST',
          headers: {
            Authorization: AUTH, 'Content-Type': 'application/octet-stream',
            RefId: hsRefId, TS: new Date().toISOString(), Desc: b64h(desc),
            LogNote: b64h(`${dtype} filed by Speedy platform. Uploaded by ${email}.`),
            FileName: b64h(fname), FileExt: ext, Channel: '32',
            ...(pol.guid ? { PolicyId: pol.guid } : {}),
          },
          body: gzipSync(buf),
        });
        hsFiled = (r2.status === 200 || r2.status === 202);
      } catch {}
      if (attachment && hsFiled) {
        await fetch(`${s.base}/rest/v1/attachments?id=eq.${attachment.id}`, {
          method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
          body: JSON.stringify({ filed_hawksoft: true, hawksoft_refid: hsRefId }),
        });
      }
    }
    return res.status(200).json({ ok: true, attachment_id: attachment && attachment.id, hawksoft_filed: hsFiled });
  }

  if (action === 'save_carrier_leg') {
    const {
      client_no, policy_id, policy_guid,
      carrier, carrier_amount, carrier_card, carrier_zero_ack,
      receipt_b64, receipt_name, receipt_mime,
      complete, // true = submit to audit (receipt required); false = save partial
    } = body;
    let payment_id = body.payment_id;   // resolved below if the page didn't pass one

    if (!client_no) return res.status(400).json({ ok: false, error: 'client_no required' });

    /* If the page was opened without a payment reference, the proof would file against
       the client but never close the audit — the charge stays "needs proof" forever even
       though the receipt is on file. Resolve it from the client's own open payments
       instead of relying on the link being passed. */
    if (!payment_id) {
      const open = await sbGet(s, `bridge_ledger?client_id=eq.${client_no}`
        + `&audit_status=in.(client_paid,carrier_pending)&is_test=is.false`
        + `&select=id,ts,amount,agent,commission_to&order=ts.desc&limit=5`);
      const cands = open.rows || [];
      if (cands.length === 1) payment_id = cands[0].id;
      else if (cands.length > 1) {
        // more than one open payment: match on the amount the client paid, else newest
        const paid = Number(body.client_paid_amount || body.paid || 0);
        const exact = paid ? cands.filter(r => Math.abs(Number(r.amount) - paid) < 0.01) : [];
        payment_id = (exact.length === 1 ? exact[0] : cands[0]).id;
      }
    }

    if (!(await mayTouchPayment(s, email, payment_id))) {
      return res.status(403).json({ ok: false, error: 'This payment was taken by another agent — they need to add its proof.' });
    }

    // Audit-complete requires the carrier receipt
    if (complete && !receipt_b64) {
      return res.status(400).json({ ok: false, error: 'Carrier receipt is required to submit to audit' });
    }

    /* Which policy the carrier receipt belongs to. Declared above BOTH readers —
       the attachments insert and the HawkSoft PolicyId header. Resolved after
       payment_id, because the ledger row is one of the places it looks. */
    const polLeg = await resolvePolicyGuid(s, {
      policy_guid, client_no, payment_id, policy_num: body.policy_num,
    });

    let attachment = null;
    let blobUrl = null;   // hoisted — the response below reads it outside the upload block
    let hsFiled = false, hsRefId = null, hsStatus = null, blobStatus = 'optional';

    if (receipt_b64) {
      const buf = b64ToBuf(receipt_b64);
      const hash = await sha256hex(buf);
      const ext = (receipt_name || '').split('.').pop() || (String(receipt_mime).includes('pdf') ? 'pdf' : 'png');
      const path = `carrier-receipts/${client_no}/${Date.now()}_${(carrier || 'carrier').replace(/[^a-z0-9]/gi, '').slice(0, 20)}.${ext}`;
      const blobRes = await storagePut(docObjectPath(client_no, receipt_name, receipt_mime), buf, receipt_mime || 'application/octet-stream');
      blobUrl = blobRes.path; blobStatus = blobRes.status + (blobRes.err ? ' ('+blobRes.err+')' : '');

      // Store attachment row in our vault — file bytes stored INLINE in Supabase (guaranteed, no Blob dependency)
      const dtype = (body.doc_type || 'carrier_receipt');
      const today = new Date().toISOString().slice(0,10);
      const amtPart = carrier_amount != null ? ('_$' + Number(carrier_amount).toFixed(2)) : '';
      const looksUuid = /^[0-9a-f-]{30,}\.[a-z]+$/i.test(receipt_name || '');
      const niceName = (receipt_name && !looksUuid)
        ? receipt_name
        : `${dtype}_${(carrier || ('client'+client_no)).replace(/[^a-z0-9]/gi,'')}${amtPart}_${today}.${ext}`;
      const attIns = await fetch(`${s.base}/rest/v1/attachments`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' },
        body: JSON.stringify([{
          client_no,
          policy_id: polLeg.guid || (UUID_RE.test(String(policy_id || '')) ? policy_id : null),
          payment_id: payment_id || null,
          kind: dtype, doc_type: dtype, filename: niceName,
          blob_url: blobUrl, file_b64: receipt_b64, thumb_b64: body.thumb_b64 || null,
          sha256: hash, mime: receipt_mime, bytes: buf.length,
          carrier: carrier || null, amount: carrier_amount != null ? Number(carrier_amount) : null,
          uploaded_by: email,
        }]),
      });
      attachment = (await attIns.json().catch(() => []))[0] || null;

      // File the carrier receipt to HawkSoft too (write-only POST — RefId is our proof of handoff)
      const ID = process.env.HAWKSOFT_CLIENT_ID, SECRET = process.env.HAWKSOFT_SECRET;
      if (ID && SECRET) {
        const AUTH = 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64');
        const refId = crypto.randomUUID();
        const fname = (receipt_name || `carrier_receipt_${carrier}`).replace(/\.[^.]+$/, '').slice(0, 60);
        const desc = `Carrier receipt ${carrier || ''} $${Number(carrier_amount || 0).toFixed(2)}`.slice(0, 41);
        const r2 = await fetch(`${HS_BASE}/vendor/agency/${AGENCY_ID}/client/${client_no}/attachment?version=4.0`, {
          method: 'POST',
          headers: {
            Authorization: AUTH, 'Content-Type': 'application/octet-stream',
            RefId: refId, TS: new Date().toISOString(),
            Desc: b64h(desc),
            LogNote: b64h(`Carrier payment receipt filed by Speedy platform. ${carrier} $${Number(carrier_amount || 0).toFixed(2)} paid via ${carrier_card || 'company card'}. Uploaded by ${email}.`),
            FileName: b64h(fname), FileExt: ext, Channel: '32',
            ...(polLeg.guid ? { PolicyId: polLeg.guid } : {}),
          },
          body: gzipSync(buf),
        });
        hsStatus = r2.status;
        hsFiled = (r2.status === 200 || r2.status === 202);
        hsRefId = refId;
        if (attachment) {
          await fetch(`${s.base}/rest/v1/attachments?id=eq.${attachment.id}`, {
            method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify({ filed_hawksoft: hsFiled, hawksoft_refid: hsRefId }),
          });
        }
      }
    }

    // Update ledger lifecycle if we have a payment_id
    const status = complete ? 'complete' : 'carrier_pending';
    let chargeAmtSeen = null;
    if (payment_id) {
      // fetch the charge amount to compute the fee
      const svcCost = (body.service_cost != null) ? Number(body.service_cost)
                    : (carrier_amount != null ? Number(carrier_amount) : null);
      let feeAmt = null;
      const led = await sbGet(s, `bridge_ledger?id=eq.${payment_id}&select=amount`);
      const chargeAmt = led.rows && led.rows[0] ? Number(led.rows[0].amount) : null;
      chargeAmtSeen = chargeAmt;
      if (chargeAmt != null && svcCost != null) feeAmt = +(chargeAmt - svcCost).toFixed(2);
      await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${payment_id}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({
          audit_status: status,
          carrier_name: carrier || null,
          carrier_paid_amount: carrier_amount != null ? Number(carrier_amount) : null,
          /* An acknowledged $0.00 must never be indistinguishable from a zero some future
             bug wrote. The flag is the difference between a claim we can audit and a
             number nobody can explain. */
          carrier_zero_ack: carrier_zero_ack === true ? true : null,
          carrier_card: carrier_card || null,
          service_cost: svcCost,
          fee_amount: feeAmt,
          service_path: body.service_path || body.svc || null,
          /* Who actually finished it. The column has existed since the ledger was
             built and NOTHING wrote it: 73 audits complete, 1 row populated. It
             matters now because completing an audit sets the carrier cost, the fee
             is amount minus that cost, and the commission is a percentage of the
             fee - so whoever completes an audit decides what the OWNER earns.
             Written only on completion; a save-and-finish-later is not finishing. */
          ...(complete ? { audit_completed_by: email } : {}),
        }),
      });
    }

    // Audit event
    await fetch(`${s.base}/rest/v1/events`, {
      method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify([{
        actor: email, kind: complete ? 'carrier_leg.completed' : 'carrier_leg.saved',
        client_no, policy_id: policy_id || null, source: 'carrier_capture',
        payload: { carrier, carrier_amount, carrier_card, status, hawksoft_filed: hsFiled, attachment_id: attachment && attachment.id },
      }]),
    });

    /* Somebody finished an audit that pays somebody else. The owner has to hear it:
       the carrier cost just set here is what their commission is calculated from,
       and without this the payment simply vanishes off their to-do list with no
       explanation. Own work makes no noise. */
    if (complete && payment_id) {
      try {
        const o = await sbGet(s, `bridge_ledger?id=eq.${encodeURIComponent(payment_id)}`
          + `&select=commission_to,amount,agent,fee_amount`);
        const row = (o.rows || [])[0];
        const owner = row && (row.commission_to || null);
        if (owner && String(owner).toLowerCase() !== String(email).toLowerCase()) {
          await fetch(`${s.base}/rest/v1/events`, {
            method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
            body: JSON.stringify([{
              actor: email, kind: 'audit.completed_by_other', client_no,
              policy_id: policy_id || null, source: 'carrier_capture',
              payload: { owner, payment_id, amount: row.amount,
                         carrier: carrier || null, carrier_amount: carrier_amount != null ? Number(carrier_amount) : null },
            }]),
          });
        }
      } catch { /* never fail an audit over a notification */ }
    }

    /* Separate row, not a field on the audit event: the acknowledgement is a statement
       the agent made, and it needs to be findable on its own. */
    if (carrier_zero_ack === true) {
      await fetch(`${s.base}/rest/v1/events`, {
        method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify([{
          actor: email, kind: 'carrier.zero_acknowledged',
          client_no, policy_id: policy_id || null, source: 'carrier_capture',
          payload: { payment_id: payment_id || null, carrier: carrier || null,
                     purpose: body.purpose || null, doc_type: body.doc_type || null,
                     charge_amount: chargeAmtSeen },
        }]),
      });
    }

    return res.status(200).json({
      ok: true, email, status,
      attachment_id: attachment && attachment.id,
      blob_url: blobUrl,
      blob_status: blobStatus,
      hawksoft_filed: hsFiled, hawksoft_status: hsStatus, hawksoft_refid: hsRefId,
    });
  }

  if (action === 'create_audit_task') {
    const { client_no, payment_id, policy_id, service_type, checklist } = body;
    if (!client_no) return res.status(400).json({ ok: false, error: 'client_no required' });
    const until = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const title = service_type === 'dmv_service' ? `DMV documents needed — client #${client_no}` : `Audit documents needed — client #${client_no}`;
    const desc = `Upload required documents to complete the audit for client #${client_no}. Reminders daily for 72h. Started by ${email}.`;
    const hs = await hsCreateTask(client_no, title, desc, email);
    const ins = await fetch(`${s.base}/rest/v1/audit_tasks`, {
      method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' },
      body: JSON.stringify([{
        client_no, payment_id: payment_id || null, policy_id: policy_id || null,
        service_type: service_type || null, status: 'open', assigned_to: email, created_by: email,
        checklist: checklist || [], hawksoft_task_refid: hs.refid,
        reminder_until: until, reminder_count: 0,
      }]),
    });
    const task = (await ins.json().catch(() => []))[0] || null;
    await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify([{ actor: email, kind: 'audit_task.created', client_no, source: 'carrier_capture',
        payload: { task_id: task && task.id, service_type, hawksoft_filed: hs.ok } }]) });
    return res.status(200).json({ ok: true, email, task_id: task && task.id, hawksoft_task: hs.ok });
  }

  if (action === 'mark_ready') {
    const { task_id, client_no, checklist } = body;
    if (!task_id) return res.status(400).json({ ok: false, error: 'task_id required' });
    await fetch(`${s.base}/rest/v1/audit_tasks?id=eq.${task_id}`, {
      method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'ready_for_audit', ...(checklist ? { checklist } : {}), updated_at: new Date().toISOString() }),
    });
    await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify([{ actor: email, kind: 'audit_task.ready', client_no: client_no || null, source: 'carrier_capture', payload: { task_id } }]) });
    return res.status(200).json({ ok: true, email, status: 'ready_for_audit' });
  }

  if (action === 'confirm_audit') {
    const { task_id, client_no } = body;
    if (!task_id) return res.status(400).json({ ok: false, error: 'task_id required' });
    await fetch(`${s.base}/rest/v1/audit_tasks?id=eq.${task_id}`, {
      method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'complete', confirmed_by: email, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    });
    await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' },
      body: JSON.stringify([{ actor: email, kind: 'audit_task.confirmed', client_no: client_no || null, source: 'audit_review', payload: { task_id } }]) });
    return res.status(200).json({ ok: true, email, status: 'complete' });
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
