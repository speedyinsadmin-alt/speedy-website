export const config = { maxDuration: 30, api: { bodyParser: { sizeLimit: '12mb' } } };
import { gzipSync } from 'node:zlib';
// /api/carrier — Phase 1: capture the carrier-payment leg + required receipt for a completed client payment.
// POST actions: save_carrier_leg (with base64 receipt) -> Blob + attachments + HawkSoft file + ledger lifecycle.
// Auth: Google ID token, allowlist. Reads/writes only our tables + files the receipt to the client's HawkSoft record.

const GOOGLE_CLIENT_ID = '495028615728-djctotdqcp1340ef3n8t339q873ok7db.apps.googleusercontent.com';
const ALLOWLIST = ['info@speedyins.com'];
const AGENCY_ID = 15112;
const HS_BASE = 'https://integration.hawksoft.app';

async function verifyGoogle(idToken) {
  if (!idToken) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (r.status !== 200) return null;
    const t = await r.json();
    if (t.aud !== GOOGLE_CLIENT_ID) return null;
    if (String(t.email_verified) !== 'true') return null;
    const email = String(t.email || '').toLowerCase();
    return ALLOWLIST.includes(email) ? email : null;
  } catch { return null; }
}

function sb() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) return null;
  return { base: url.replace(/\/$/, ''), hdrs: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
}

async function blobPut(path, buf, contentType) {
  const tok = process.env.BLOB_READ_WRITE_TOKEN;
  if (!tok) return { url: null, status: 'no_token' };
  const r = await fetch(`https://blob.vercel-storage.com/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok}`, 'x-api-version': '7', 'content-type': contentType || 'application/octet-stream', 'x-add-random-suffix': '1' },
    body: buf,
  });
  if (r.status !== 200) { const errtxt = await r.text().catch(()=> ''); return { url: null, status: 'http_' + r.status, err: errtxt.slice(0,120) }; }
  const j = await r.json().catch(() => null);
  return { url: j && j.url ? j.url : null, status: 'ok' };
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

  if (action === 'save_carrier_leg') {
    const {
      client_no, policy_id, policy_guid, payment_id,
      carrier, carrier_amount, carrier_card,
      receipt_b64, receipt_name, receipt_mime,
      complete, // true = submit to audit (receipt required); false = save partial
    } = body;

    if (!client_no) return res.status(400).json({ ok: false, error: 'client_no required' });

    // Audit-complete requires the carrier receipt
    if (complete && !receipt_b64) {
      return res.status(400).json({ ok: false, error: 'Carrier receipt is required to submit to audit' });
    }

    let attachment = null;
    let hsFiled = false, hsRefId = null, hsStatus = null, blobStatus = 'optional';

    if (receipt_b64) {
      const buf = b64ToBuf(receipt_b64);
      const hash = await sha256hex(buf);
      const ext = (receipt_name || '').split('.').pop() || (String(receipt_mime).includes('pdf') ? 'pdf' : 'png');
      const path = `carrier-receipts/${client_no}/${Date.now()}_${(carrier || 'carrier').replace(/[^a-z0-9]/gi, '').slice(0, 20)}.${ext}`;
      const blobRes = await blobPut(path, buf, receipt_mime || 'application/octet-stream');
      const url = blobRes.url; blobStatus = blobRes.status + (blobRes.err ? ' ('+blobRes.err+')' : '');

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
          client_no, policy_id: policy_id || null, payment_id: payment_id || null,
          kind: dtype, doc_type: dtype, filename: niceName,
          blob_url: url, file_b64: receipt_b64, sha256: hash, mime: receipt_mime, bytes: buf.length,
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
            ...(policy_guid ? { PolicyId: policy_guid } : {}),
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
    const status = complete ? 'audit_complete' : 'carrier_pending';
    if (payment_id) {
      await fetch(`${s.base}/rest/v1/bridge_ledger?id=eq.${payment_id}`, {
        method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' },
        body: JSON.stringify({
          audit_status: status,
          carrier_name: carrier || null,
          carrier_paid_amount: carrier_amount != null ? Number(carrier_amount) : null,
          carrier_card: carrier_card || null,
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

    return res.status(200).json({
      ok: true, email, status,
      attachment_id: attachment && attachment.id,
      blob_url: url,
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
