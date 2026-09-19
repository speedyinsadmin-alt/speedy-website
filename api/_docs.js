/* api/_docs.js — a photo texted in becomes a client document (Stage 3 item 4, Sep 18).
   Shared by chat.js (link / unlink / the agent's tap) and rc-sms.js (a new photo on a
   thread that is already a confirmed client). An underscore file is not a function.

   The rule: only a CONFIRMED client gets the photo. It lands on the platform as an
   untyped document ("Needs a label" on the Documents tab) and nothing goes to HawkSoft
   until an agent gives it a type. The same photo twice (sha256) is one document.

   The bytes: the chat copy stays in the private chat-media bucket with the text; the
   document is its own object in client-documents, the bucket every document lives in
   (carrier.js DOC_BUCKET). The attachments row is the one the Documents tab already
   reads; `source` says it came from a text and which message. Never throws. */
import { createHash } from 'node:crypto';
const enc = encodeURIComponent;
const CHAT_BUCKET = 'chat-media', DOC_BUCKET = 'client-documents';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

async function sbGet(s, path) { const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs }); const rows = await r.json().catch(() => null); return Array.isArray(rows) ? rows : []; }
async function getObject(s, bucket, path) {
  const r = await fetch(`${s.base}/storage/v1/object/${bucket}/${path}`, { headers: { apikey: s.hdrs.apikey, Authorization: s.hdrs.Authorization } });
  if (r.status !== 200) return null;
  return Buffer.from(await r.arrayBuffer());
}
async function putObject(s, bucket, path, buf, contentType) {
  const r = await fetch(`${s.base}/storage/v1/object/${bucket}/${path}`, { method: 'POST', headers: { apikey: s.hdrs.apikey, Authorization: s.hdrs.Authorization, 'Content-Type': contentType || 'application/octet-stream', 'cache-control': 'max-age=31536000', 'x-upsert': 'false' }, body: buf });
  return r.status === 200;
}
async function delObject(s, bucket, path) { try { await fetch(`${s.base}/storage/v1/object/${bucket}/${path}`, { method: 'DELETE', headers: { apikey: s.hdrs.apikey, Authorization: s.hdrs.Authorization } }); } catch { /* an orphan object is not a failure */ } }
async function record(s, ev) { try { await fetch(`${s.base}/rest/v1/events`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify([ev]) }); } catch { /* the trail never blocks */ } }
const uuid = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : [8, 4, 4, 4, 12].map(n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')).join('-');

/* the photos on one message: { index, a } for each stored image / pdf not yet a document */
const photosOf = m => (Array.isArray(m.attachments) ? m.attachments : []).map((a, index) => ({ a, index }))
  .filter(x => x.a && x.a.ok && x.a.path && /^(image\/|application\/pdf)/.test(String(x.a.content_type || '')));

/* One photo -> one client document. Returns { attachment_id, dup } or { error }. */
export async function savePhoto(s, conv, msg, index, by) {
  try {
    const a = (msg.attachments || [])[index];
    if (!a || !a.ok || !a.path) return { error: 'not_stored' };
    if (a.doc_id) return { attachment_id: a.doc_id, dup: true };
    if (!conv.client_no || conv.link_status !== 'confirmed') return { error: 'not_confirmed' };
    const buf = await getObject(s, CHAT_BUCKET, a.path);
    if (!buf || !buf.length) return { error: 'no_bytes' };
    const hash = createHash('sha256').update(buf).digest('hex');
    const dup = await sbGet(s, `attachments?client_no=eq.${conv.client_no}&sha256=eq.${hash}&select=id&limit=1`);
    let attachment_id, wasDup = false;
    if (dup[0]) { attachment_id = dup[0].id; wasDup = true; }
    else {
      const ext = EXT[String(a.content_type || '').toLowerCase()] || 'bin';
      const phone = String(conv.visitor_phone || '');
      const day = new Date(msg.ts || Date.now()).toISOString().slice(0, 10);
      const filename = `text_${phone || 'unknown'}_${day}_${index + 1}.${ext}`;
      const path = `${conv.client_no}/${uuid()}.${ext}`;
      if (!(await putObject(s, DOC_BUCKET, path, buf, a.content_type))) return { error: 'store_failed' };
      const ins = await fetch(`${s.base}/rest/v1/attachments`, { method: 'POST', headers: { ...s.hdrs, Prefer: 'return=representation' }, body: JSON.stringify([{
        client_no: conv.client_no, payment_id: null, policy_id: null, kind: 'document', doc_type: null, doc_label: null, filename, blob_url: path, file_b64: null,
        sha256: hash, mime: a.content_type || null, bytes: buf.length, uploaded_by: by || 'customer', filed_hawksoft: false,
        source: { kind: 'text', conversation_id: conv.id, message_id: msg.id, index, phone: phone || null, line: conv.line || null },
      }]) });
      const rows = await ins.json().catch(() => []);
      if (!ins.ok || !rows[0]) { await delObject(s, DOC_BUCKET, path); return { error: 'row_failed' }; }
      attachment_id = rows[0].id;
      await record(s, { actor: by || 'system', kind: 'document.added_from_text', source: 'chat', client_no: conv.client_no, payload: { attachment_id, conversation_id: conv.id, message_id: msg.id, index, phone: phone || null, bytes: buf.length, mime: a.content_type || null, filename, is_test: conv.is_test === true } });
    }
    /* remember it on the message so the thread tile can say "in Documents" */
    const atts = (msg.attachments || []).map((x, i) => i === index ? { ...x, doc_id: attachment_id } : x);
    await fetch(`${s.base}/rest/v1/messages?id=eq.${msg.id}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify({ attachments: atts }) });
    msg.attachments = atts;
    return { attachment_id, dup: wasDup };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

/* Every photo on the thread, past and future: called when a client is linked (catch-up)
   and by rc-sms for each new photo. Skips what is already a document. */
export async function savePhotosOnThread(s, conv, by, onlyMessageId) {
  const out = { saved: 0, dup: 0, skipped: 0, errors: [] };
  try {
    if (!conv || !conv.client_no || conv.link_status !== 'confirmed' || conv.is_test === true) return out;
    const q = onlyMessageId ? `messages?id=eq.${onlyMessageId}&select=id,ts,attachments` : `messages?conversation_id=eq.${conv.id}&attachments=not.is.null&select=id,ts,attachments&order=id.asc&limit=200`;
    for (const m of await sbGet(s, q)) {
      for (const { a, index } of photosOf(m)) {
        if (a.doc_id) { out.skipped++; continue; }
        const r = await savePhoto(s, conv, m, index, by);
        if (r.error) out.errors.push(r.error); else if (r.dup) out.dup++; else out.saved++;
      }
    }
  } catch (e) { out.errors.push(String(e && e.message || e)); }
  return out;
}

/* "Not them" / "Not a client document": the UNTYPED documents this thread put on the
   client come off it (row + object). A typed one stays - an agent said what it is - and
   an unlink leaves a note on the client saying why it is still there. */
export async function removePhotos(s, conv, by, only) {
  const out = { removed: 0, kept: 0 };
  try {
    if (!conv || !conv.client_no) return out;
    const rows = await sbGet(s, `attachments?client_no=eq.${conv.client_no}&source->>conversation_id=eq.${conv.id}&select=id,doc_type,blob_url,filed_hawksoft,source,filename`);
    const gone = new Set();
    for (const r of rows) {
      const src = r.source || {};
      if (only && String(r.id) !== String(only.attachment_id)) continue;
      if (r.doc_type && !only) { out.kept++; continue; }   /* typed: an agent's decision stands on an unlink */
      if (r.filed_hawksoft) { out.kept++; continue; }        /* HawkSoft has it: nothing to undo there */
      await fetch(`${s.base}/rest/v1/attachments?id=eq.${r.id}`, { method: 'DELETE', headers: s.hdrs });
      if (r.blob_url) await delObject(s, DOC_BUCKET, r.blob_url);
      out.removed++; gone.add(String(r.id));
      await record(s, { actor: by || 'system', kind: 'document.removed_from_text', source: 'chat', client_no: conv.client_no, payload: { attachment_id: r.id, conversation_id: conv.id, message_id: src.message_id || null, filename: r.filename, why: only ? 'not_a_client_document' : 'unlinked' } });
    }
    /* every tile that pointed at a removed document forgets it - a duplicate photo on a
       second message points at the same document as the first */
    if (gone.size) for (const m of await sbGet(s, `messages?conversation_id=eq.${conv.id}&attachments=not.is.null&select=id,attachments`)) {
      if (!(m.attachments || []).some(x => x && gone.has(String(x.doc_id)))) continue;
      const atts = m.attachments.map(x => x && gone.has(String(x.doc_id)) ? { ...x, doc_id: null } : x);
      await fetch(`${s.base}/rest/v1/messages?id=eq.${m.id}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify({ attachments: atts }) });
    }
    if (out.kept && !only) await record(s, { actor: by || 'system', kind: 'document.kept_after_unlink', source: 'chat', client_no: conv.client_no, payload: { conversation_id: conv.id, kept: out.kept, note: 'typed or filed documents from this text stay; an agent decided what they are' } });
  } catch { /* nothing to undo is not a failure */ }
  return out;
}
