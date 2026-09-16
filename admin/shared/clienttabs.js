/* THE CLIENT'S TABS — Payments · Documents · Log (Sep 16).
   One renderer for the agent portal and the Console, like paycard.js. The client page
   used to hide the payment card behind a toggle and show a three-line "Recent
   activity"; that list was a baby log, and the documents hung off whichever payment
   they were uploaded with. Saif: "a log tab maybe, and an attachment tab for each
   client page". So:
     ClientTabs.html(clientCard, { me, clientNo, actions, page, payHtml, rerender })
   returns the strip and the open tab's body. State is per client (which tab is open)
   and lives here. Documents are grouped by what they are, with the ones still carrying
   no real type on a "needs a label" shelf; thumbnails come from the row when it has one
   and are drawn in the browser (pdf.js, first page) when it does not, then saved so the
   next agent gets them for free. The Log is every event on the client, and the charges
   and documents that have no event of their own, as sentences in order.
   Both pages load this as a plain script beside clienttabs.css; there is no bundler. */
(function(){
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const money = n => { const v = Number(n||0); return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); };
const TAB = {};                       // client_no -> 'payments' | 'documents' | 'log'
let CUR = null;                       // the last card rendered, for handlers
function t(ts, o){ try { return new Date(ts).toLocaleString('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, o)); } catch(e){ return String(ts || '').slice(0, 16); } }
const whenShort = ts => t(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = ts => t(ts, { hour: 'numeric', minute: '2-digit' });
const dayKey = ts => t(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = ts => t(ts, { weekday: 'long', month: 'short', day: 'numeric' });
function bytesLabel(b){ if(!b) return ''; return b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b/1024) + ' KB' : (b/1048576).toFixed(1) + ' MB'; }
/* Names, never emails. The card returns agent_names (the roster); anything not on it
   shows as the part before the @, capitalised. */
function nameOf(email, c){
  const e = String(email || '').toLowerCase().trim();
  if(!e) return '';
  const m = e.match(/\(([^)]+@[^)]+)\)/); if(m) return nameOf(m[1], c);
  const names = (c && c.agent_names) || {};
  if(names[e]) return names[e];
  if(!e.includes('@')) return String(email);
  const local = e.split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : e;
}
const first = (email, c) => String(nameOf(email, c)).split(' ')[0];
/* the same words the card uses for a type */
function typeLabel(d){
  const k = d.doc_type || d.kind || 'document';
  const L = { carrier_receipt: 'Carrier receipt', proof: 'Carrier receipt', client_receipt: 'Speedy receipt',
    carrier_application: 'Signed application', carrier_endo: 'Signed endorsement', hawksoft_endo: 'HawkSoft endorsement',
    cancellation: 'Cancellation request', dec_page: 'Dec page', driver_license: "Driver's license", id_card: 'ID card',
    vehicle_photo: 'Vehicle photo', property_photo: 'Property photo', dmv_receipt: 'DMV receipt',
    endorsement_no_payment: 'Endorsement paperwork', cancellation_no_payment: 'Cancellation paperwork', supporting_no_payment: 'Supporting document',
    refund_confirmation_en: 'Refund confirmation (English)', refund_confirmation_es: 'Confirmación de reembolso (Español)', other: 'Other' };
  if(!d.doc_type && (!d.kind || d.kind === 'document')) return /^image\//i.test(String(d.mime || '')) ? 'Photo' : 'Document';   // untyped: say what it physically is
  if(d.kind === 'refund_confirmation' && d.doc_label) return d.doc_label;
  if(k === 'other' && d.doc_label) return d.doc_label;
  return L[k] || String(k).replace(/_/g, ' ');
}
/* WHICH SHELF. Receipts and slips are what the client gets; carrier receipts prove a
   payment; signed paperwork is the policy's paper; ID and photos are the client's. */
function groupOf(d){
  const k = String(d.doc_type || d.kind || '');
  if(d.kind === 'client_receipt' || d.kind === 'refund_confirmation') return 'receipts';
  if(d.kind === 'proof' || k === 'carrier_receipt' || k === 'dmv_receipt') return 'carrier';
  if(/^(carrier_application|carrier_endo|hawksoft_endo|cancellation|dec_page|endorsement_no_payment|cancellation_no_payment|supporting_no_payment)$/.test(k)) return 'signed';
  if(/^(driver_license|id_card|vehicle_photo|property_photo)$/.test(k)) return 'id';
  return 'other';
}
const GROUPS = [['receipts', 'Receipts & refund slips'], ['carrier', 'Carrier receipts'], ['signed', 'Signed applications & paperwork'], ['id', 'ID, photos & other'], ['other', 'Other']];
/* NEEDS A LABEL: no type at all, or "other" with nothing said. The review sheet has
   made agents pick since Sep 15, so this is mostly the older rows. */
function needsLabel(d){
  if(d.kind === 'client_receipt' || d.kind === 'refund_confirmation' || d.kind === 'proof') return false;
  const k = String(d.doc_type || '').trim();
  if(!k || k === 'document') return true;
  if(k === 'other' && !String(d.doc_label || '').trim()) return true;
  return false;
}
/* SORT (Sep 16). One control per list, remembered per list for the session. Each list
   names the keys it can sort by; the key reads the field off the row. */
const SORTS = {};
function sortKey(list){ return SORTS[list] || 'newest'; }
function sortHtml(list, keys, fn){
  return '<span class="ctsort"><span class="dim">Sort</span> <select class="ctsel" onchange="' + fn + '(\'' + list + '\', this.value)">'
    + keys.map(([k, l]) => '<option value="' + k + '"' + (sortKey(list) === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></span>';
}
function sortRows(rows, key, fields){
  const f = fields[key] || fields.newest;
  const cmp = (a, b) => { const x = f(a), y = f(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); };
  const out = rows.slice().sort(cmp);
  return key === 'newest' || key === 'biggest' ? out.reverse() : out;
}
function setSort(list, key){ SORTS[list] = key; if(CUR && CUR.opts && typeof CUR.opts.rerender === 'function') CUR.opts.rerender(CUR.opts.clientNo || (CUR.c && CUR.c.client && CUR.c.client.client_no)); }
const DOC_SORT_KEYS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['type', 'By type'], ['who', 'By who uploaded'], ['biggest', 'Biggest first']];
const DOC_SORT_FIELDS = { newest: d => d.created_at || '', oldest: d => d.created_at || '', type: d => typeLabel(d).toLowerCase(), who: d => String(d.uploaded_by || '').toLowerCase(), biggest: d => Number(d.bytes || 0) };
const canRelabel = d => !(['client_receipt', 'proof', 'carrier_receipt', 'refund_confirmation'].includes(String(d.kind || '')) || /_no_payment$/.test(String(d.doc_type || '')));
const isPdf = d => /pdf/i.test(String(d.mime || '')) || /\.pdf$/i.test(String(d.filename || ''));
const isImg = d => /^image\//i.test(String(d.mime || ''));

/* ---------------- the strip ---------------- */
function html(c, opts){
  opts = Object.assign({ me: null, clientNo: null, actions: true, page: 'portal', payHtml: '', rerender: null }, opts || {});
  CUR = { c, opts };
  const no = opts.clientNo || (c.client && c.client.client_no);
  const tab = TAB[no] || 'payments';
  const docs = c.documents || [];
  const nl = docs.filter(needsLabel).length;
  const pays = (c.payments || []).length;
  const logN = logEntries(c).length;
  const tabBtn = (k, label, n, extra) => '<span class="ctab' + (tab === k ? ' on' : '') + '" onclick="ClientTabs.set(' + Number(no) + ',\'' + k + '\')">' + label
    + '<span class="n">' + n + '</span>' + (extra || '') + '</span>';
  let h = '<div class="ctabs" data-client="' + Number(no) + '">'
    + tabBtn('payments', 'Payments', pays)
    + tabBtn('documents', 'Documents', docs.length, nl ? '<span class="n nwarn" title="' + nl + ' need' + (nl === 1 ? 's' : '') + ' a label">&#9888; ' + nl + '</span>' : '')
    + tabBtn('log', 'Log', logN)
    + '</div>';
  h += '<div class="ctabbody" data-tab="' + tab + '">';
  if(tab === 'payments') h += opts.payHtml || '';
  else if(tab === 'documents') h += docsHtml(c, opts);
  else h += logHtml(c, opts);
  h += '</div>';
  return h;
}
function set(no, tab){
  TAB[no] = tab;
  if(CUR && CUR.opts && typeof CUR.opts.rerender === 'function') CUR.opts.rerender(no);
}
function current(no){ return TAB[no] || 'payments'; }

/* ---------------- Documents ---------------- */
function forLine(d, c){
  if(!d.payment_id) return 'Not tied to a payment';
  const p = (c.payments || []).find(x => x.id === d.payment_id);
  if(!p) return 'For a payment not on this card';
  if(p.refund_of) return 'For the ' + (p.voided ? 'cancelled charge' : 'refund') + ' of ' + t(p.ts, { month: 'short', day: 'numeric' });
  return (d.kind === 'proof' || d.doc_type === 'carrier_receipt' ? 'Proves' : 'For') + ' the ' + money(p.amount) + ' payment of ' + t(p.ts, { month: 'short', day: 'numeric' })
    + (p.purpose ? ' · ' + esc(p.purpose) : '');
}
/* the thumbnail box: the row's own thumb when it has one, a drawn mini-slip for the
   PDFs the platform makes, and a placeholder pdf.js fills in for the rest */
function thumbBox(d, c){
  if(d.kind === 'client_receipt' || d.kind === 'refund_confirmation'){
    const p = d.payment_id ? (c.payments || []).find(x => x.id === d.payment_id) : null;
    const refund = d.kind === 'refund_confirmation';
    const amt = p ? Math.abs(Number(p.amount || 0)) : Number(d.amount || 0);
    return '<div class="dthumb slip' + (refund ? ' refund' : '') + '"><i>SPEEDY</i><b>' + (refund ? (p && p.voided ? 'CANCELLED' : 'REFUND') : 'RECEIPT') + '</b><em>' + (refund ? '-' : '') + '$' + amt.toFixed(2) + '</em></div>';
  }
  if(isImg(d)) return '<div class="dthumb img" data-thumb-for="' + esc(d.id) + '"><span>IMG</span></div>';
  if(isPdf(d)) return '<div class="dthumb pdf" data-thumb-for="' + esc(d.id) + '" data-pdf="1"><span>PDF</span></div>';
  return '<div class="dthumb" data-thumb-for="' + esc(d.id) + '"><span>FILE</span></div>';
}
function docRow(d, c, opts){
  const hs = d.filed_hawksoft ? '<span class="hs">&#10003; HawkSoft</span>'
    : (d.doc_type === 'client_receipt' || d.kind === 'refund_confirmation' ? '<span class="hs no">not in HawkSoft</span>' : '<span class="hs no">on the platform only</span>');
  const es = d.kind === 'refund_confirmation' && d.doc_type === 'refund_confirmation_en'
    ? ((c.documents || []).some(x => x.payment_id === d.payment_id && x.doc_type === 'refund_confirmation_es')
        ? '' : ' · <a class="dlink" onclick="event.stopPropagation();openRefundSlip(\'' + esc(d.payment_id) + '\',\'es\')">Español</a> not made yet')
    : '';
  /* receipts and slips are MADE by the platform; the row names the person it was made for */
  const madeBy = d.kind === 'client_receipt' || d.kind === 'refund_confirmation';
  const person = (d.uploaded_by === 'platform' || d.uploaded_by === 'charge_page') ? '' : nameOf(d.uploaded_by, c);
  const who = madeBy ? 'the platform' + (person ? ' for ' + person : '') : (person || 'the platform');
  const rel = opts.actions && canRelabel(d);
  return '<div class="drow" onclick="ClientTabs.preview(\'' + esc(d.id) + '\')">'
    + thumbBox(d, c)
    + '<div class="b"><div class="t">' + esc(typeLabel(d)) + (needsLabel(d) ? ' <span class="nl">· not confirmed</span>' : '') + '</div>'
    + '<div class="s">' + forLine(d, c) + ' · <b>' + esc(who) + '</b> · ' + esc(whenShort(d.created_at)) + (d.bytes ? ' · ' + bytesLabel(d.bytes) : '') + ' · ' + hs + es + '</div></div>'
    + '<div class="more" onclick="event.stopPropagation();ClientTabs.menu(\'' + esc(d.id) + '\',this)" title="More">&#8943;</div>'
    + '</div>';
}
function docsHtml(c, opts){
  const docs = sortRows(c.documents || [], sortKey('docs'), DOC_SORT_FIELDS);
  const no = opts.clientNo || (c.client && c.client.client_no);
  let h = '<div class="ctdocs">';
  if((c.documents || []).length > 1) h += '<div class="ctsortrow">' + sortHtml('docs', DOC_SORT_KEYS, 'ClientTabs.sort') + '</div>';
  const nl = docs.filter(needsLabel);
  if(nl.length){
    h += '<div class="shelf"><div class="h">Needs a label · ' + nl.length + '</div>'
      + nl.map(d => docRow(d, c, opts) + (opts.actions ? '<div class="acts"><span class="chg" onclick="ClientTabs.relabel(\'' + esc(d.id) + '\')">Say what it is…</span></div>' : '')).join('')
      + '</div>';
  }
  const rest = docs.filter(d => !needsLabel(d));
  for(const [g, label] of GROUPS){
    const list = rest.filter(d => groupOf(d) === g);
    if(!list.length && g === 'other') continue;
    h += '<div class="dgrp">' + label + (list.length ? ' · ' + list.length : '') + '</div>';
    h += list.length ? list.map(d => docRow(d, c, opts)).join('') : '<div class="dnone">None on the platform.</div>';
  }
  if(!docs.length) h += '<div class="dnone" style="margin-top:4px">No documents on the platform for this client yet.</div>';
  if(opts.actions) h += '<div class="dfoot"><div class="up" onclick="ClientTabs.upload(' + Number(no) + ')">&#65291; Add documents to this client</div></div>';
  h += '<div class="honest">Documents from before Sep 5 live in HawkSoft only — open the client in CMS for those. HawkSoft cannot be read back from here.</div>';
  h += '</div>';
  setTimeout(() => fillThumbs(no, c), 0);
  return h;
}
/* the ⋯ menu: open in a new tab, change the type (when it is a document) */
function menu(id, el){
  const c = CUR && CUR.c; const d = ((c && c.documents) || []).find(x => x.id === id); if(!d) return;
  closeMenu();
  const m = document.createElement('div'); m.className = 'dmenu'; m.id = 'ctDmenu';
  m.innerHTML = '<div onclick="ClientTabs.preview(\'' + esc(id) + '\')">Preview</div>'
    + '<div onclick="openPortalDoc(\'' + esc(id) + '\')">Open in a new tab</div>'
    + (CUR.opts.actions && canRelabel(d) ? '<div onclick="ClientTabs.relabel(\'' + esc(id) + '\')">Change what it is…</div>' : '')
    + '<div class="dim">' + esc(d.filename || '') + '</div>';
  el.parentNode.style.position = 'relative'; el.parentNode.appendChild(m);
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu(){ const m = document.getElementById('ctDmenu'); if(m) m.remove(); }
/* relabel = the carrier page's set_doc_type, asked here with a small picker */
const RELABEL = [['carrier_application', 'Signed application'], ['carrier_endo', 'Signed endorsement'], ['hawksoft_endo', 'HawkSoft endorsement'], ['cancellation', 'Cancellation request'], ['dec_page', 'Dec page'], ['driver_license', "Driver's license"], ['id_card', 'ID card'], ['vehicle_photo', 'Vehicle photo'], ['property_photo', 'Property photo'], ['other', 'Something else…']];
async function relabel(id){
  closeMenu();
  const c = CUR && CUR.c; const d = ((c && c.documents) || []).find(x => x.id === id); if(!d) return;
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'ctRelabel';
  box.innerHTML = '<div class="ctpanel small"><div class="hd"><b>What is this document?</b><span class="x" onclick="document.getElementById(\'ctRelabel\').remove()">&#10005;</span></div>'
    + '<div class="chips">' + RELABEL.map(([k, l]) => '<span class="chip' + (d.doc_type === k ? ' on' : '') + '" data-k="' + k + '">' + l + '</span>').join('') + '</div>'
    + '<input id="ctLabel" class="ctin" placeholder="Say what it is (for Something else)" maxlength="41" value="' + esc(d.doc_label || '') + '" style="display:none">'
    + '<div class="msg" id="ctRelMsg"></div>'
    + '<div class="btns"><span class="ok" id="ctRelOk">Save</span></div></div>';
  document.body.appendChild(box);
  let pick = d.doc_type || null;
  box.querySelectorAll('.chip').forEach(ch => ch.onclick = () => { box.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); ch.classList.add('on'); pick = ch.dataset.k; document.getElementById('ctLabel').style.display = pick === 'other' ? 'block' : 'none'; });
  if(pick === 'other') document.getElementById('ctLabel').style.display = 'block';
  document.getElementById('ctRelOk').onclick = async () => {
    const label = document.getElementById('ctLabel').value.trim();
    const msg = document.getElementById('ctRelMsg');
    if(!pick){ msg.textContent = 'Pick one.'; return; }
    if(pick === 'other' && !label){ msg.textContent = 'Say what it is.'; return; }
    msg.textContent = 'Saving…';
    const r = await carrierPost({ action: 'set_doc_type', attachment_id: id, doc_type: pick, doc_label: pick === 'other' ? label : null });
    if(!r || !r.ok){ msg.textContent = (r && (r.message || r.error)) || 'Could not save.'; return; }
    d.doc_type = pick; d.kind = pick; d.doc_label = pick === 'other' ? label : null;
    box.remove();
    if(CUR.opts.rerender) CUR.opts.rerender(CUR.opts.clientNo || (c.client && c.client.client_no));
  };
}
/* THE PAGE'S TOKEN. Both pages declare `let TOKEN` at top level - a lexical global,
   NOT window.TOKEN - so reading window.TOKEN sent every carrier call out empty and the
   server said "Not authorized" (found live, Sep 16). A classic script shares the global
   lexical scope, so the bare name is the one that works; window.TOKEN is the fallback. */
function pageToken(){ try{ if(typeof TOKEN !== 'undefined' && TOKEN) return TOKEN; }catch(e){} return (typeof window.TOKEN !== 'undefined' && window.TOKEN) || ''; }
/* the two pages talk to /api/carrier the same way */
async function carrierPost(body){
  try{
    const tok = pageToken();
    const r = await fetch('/api/carrier', { method: 'POST', headers: { 'x-id-token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  }catch(e){ return null; }
}
function uploadUrl(no){
  const c = CUR && CUR.c; const cl = (c && c.client) || {};
  const name = cl.business_name || [cl.first_name, cl.last_name].filter(Boolean).join(' ');
  const p = new URLSearchParams({ client: no, name, docs: '1', nopay: '1' });
  const tok = pageToken();
  return '/admin/carrier.html?' + p.toString() + (tok ? '#tok=' + encodeURIComponent(tok) : '');
}
function upload(no){
  if(typeof window.stashHandoff === 'function') try{ window.stashHandoff(); }catch(e){}
  location.href = uploadUrl(no);
}

/* ---------------- thumbnails ---------------- */
let PDFJS = null;
async function pdfjs(){
  if(PDFJS) return PDFJS;
  const lib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.min.mjs';
  PDFJS = lib; return lib;
}
/* Fill the boxes: stored thumbs first (one small call), then draw the PDFs that have
   none - first page, 240px, JPEG - and save each so it is drawn once ever. */
async function fillThumbs(no, c, root){
  const boxes = [...document.querySelectorAll((root || '.ctdocs') + ' [data-thumb-for]')];
  if(!boxes.length) return;
  const have = new Set();
  try{
    const r = await window.api('portal_thumbs&no=' + encodeURIComponent(no));
    ((r && r.thumbs) || []).forEach(x => { have.add(x.id); setThumb(x.id, x.thumb_b64); });
  }catch(e){}
  const todo = boxes.filter(b => b.dataset.pdf === '1' && !have.has(b.dataset.thumbFor)).slice(0, 8);
  for(const b of todo){
    const id = b.dataset.thumbFor;
    try{
      const r = await window.api('portal_doc&id=' + encodeURIComponent(id));
      if(!r || !r.ok || !r.file_b64) continue;
      const dataUrl = await window.ClientTabs.pdfFirstPage(r.file_b64);   // through the export, so a page can swap the renderer
      if(!dataUrl) continue;
      setThumb(id, dataUrl);
      carrierPost({ action: 'set_thumb', attachment_id: id, thumb_b64: dataUrl });
    }catch(e){ /* the placeholder stays; nothing else is affected */ }
  }
}
function setThumb(id, dataUrl){
  document.querySelectorAll('[data-thumb-for="' + id + '"]').forEach(b => {
    b.innerHTML = '<img src="' + dataUrl + '" alt="">'; b.classList.add('has');
  });
}
async function pdfFirstPage(b64){
  const lib = await pdfjs();
  let s = b64; if(s.startsWith('data:')) s = s.split(',')[1] || '';
  const bin = atob(s), arr = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const doc = await lib.getDocument({ data: arr }).promise;
  const page = await doc.getPage(1);
  const v0 = page.getViewport({ scale: 1 });
  const scale = 240 / Math.max(v0.width, v0.height);
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  /* intent 'print': the display intent paints on requestAnimationFrame, which never
     fires in a background tab - the render hung forever while the agent was on another
     tab (found live, Sep 16). Print intent paints straight away. */
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, intent: 'print' }).promise;
  return cv.toDataURL('image/jpeg', 0.6);
}

/* ---------------- preview ---------------- */
async function preview(id, doc){
  closeMenu();
  const c = CUR && CUR.c; const d = doc || ((c && c.documents) || []).find(x => x.id === id);
  const old = document.getElementById('ctPreview'); if(old) old.remove();
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'ctPreview';
  box.innerHTML = '<div class="ctpanel"><div class="hd"><b>' + esc(d ? typeLabel(d) : 'Document') + '</b>'
    + '<span class="acts"><a onclick="openPortalDoc(\'' + esc(id) + '\')">Open in a new tab</a><span class="x" onclick="document.getElementById(\'ctPreview\').remove()">&#10005;</span></span></div>'
    + '<div class="body"><div class="dim" style="padding:24px">Loading…</div></div></div>';
  box.onclick = e => { if(e.target === box) box.remove(); };
  document.body.appendChild(box);
  try{
    const r = await window.api('portal_doc&id=' + encodeURIComponent(id));
    const body = box.querySelector('.body');
    if(!r || !r.ok || !r.file_b64){ body.innerHTML = '<div class="dim" style="padding:24px">No file is stored for this document.</div>'; return; }
    let b64 = r.file_b64; if(b64.startsWith('data:')) b64 = b64.split(',')[1] || '';
    const bin = atob(b64), arr = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const mime = r.mime || (d && d.mime) || 'application/pdf';
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    body.innerHTML = /^image\//.test(mime) ? '<img src="' + url + '" alt="">' : '<iframe src="' + url + '#toolbar=0" title="preview"></iframe>';
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }catch(e){ const body = box.querySelector('.body'); if(body) body.innerHTML = '<div class="dim" style="padding:24px">That document could not be opened.</div>'; }
}

/* ---------------- Log ---------------- */
const REASON = { charged_twice: 'charged twice', wrong_amount: 'wrong amount taken', policy_cancelled: 'policy cancelled', never_bound: 'never bound', other: 'other' };
/* Every entry: { ts, cat, who, text (html), meta (html) }. cat: money · doc · mail · review · other */
function logEntries(c){
  const out = [];
  const pays = c.payments || [], docs = c.documents || [], evs = c.events || [];
  const payById = Object.fromEntries(pays.map(p => [p.id, p]));
  const attIdsInEvents = new Set(evs.map(e => e.payload && e.payload.attachment_id).filter(Boolean));
  const noteAttIds = new Set(evs.flatMap(e => (e.kind === 'note.added' && e.payload && Array.isArray(e.payload.attachments)) ? e.payload.attachments : []));
  const N = e => '<b>' + esc(nameOf(e, c)) + '</b>';
  const payRef = p => p ? 'the ' + money(Math.abs(Number(p.amount || 0))) + ' payment of ' + t(p.ts, { month: 'short', day: 'numeric' }) : 'a payment';
  /* the review events name the attachment, not the payment: follow the document to its row */
  const docById = Object.fromEntries(docs.map(d => [d.id, d]));
  const payOf = p => payById[p.payment_id] || (p.attachment_id && docById[p.attachment_id] ? payById[docById[p.attachment_id].payment_id] : null);
  /* charges and refunds from the ledger - a charge has no event of its own */
  for(const p of pays){
    if(p.refund_of){
      if(!evs.some(e => e.kind === 'payment.refunded' && e.payload && e.payload.refund_id === p.id)){
        const parent = payById[p.refund_of];
        out.push({ ts: p.ts, cat: 'money', k: 'refund', who: p.charged_by_email, text: N(p.charged_by_email || p.charged_by) + ' refunded <b>' + money(Math.abs(Number(p.amount || 0))) + '</b> of ' + payRef(parent),
          meta: [p.refund_reason ? REASON[p.refund_reason] || p.refund_reason : '', p.ref].filter(Boolean).join(' · ') });
      }
      continue;
    }
    const isLink = /paylink/.test(String(p.kind || '')), inv = p.audit_status === 'invoice_open';
    out.push({ ts: p.ts, cat: 'money', k: inv ? 'invoice' : isLink ? 'paylink' : 'charge', who: p.charged_by_email, amount: Number(p.amount || 0), pay: p, text: N(p.charged_by_email || p.charged_by) + (inv ? ' opened an invoice for <b>' : isLink ? ' sent a pay link for <b>' : ' charged <b>') + money(p.amount) + '</b>' + (p.purpose ? ' — ' + esc(p.purpose) : ''),
      meta: [p.ref && !/^Clover refund|Cash returned$/.test(p.ref) ? esc(p.ref) : '', p.carrier_name ? 'carrier ' + esc(p.carrier_name) : ''].filter(Boolean).join(' · ') });
    if(p.client_notice && !inv && !isLink){
      const n = p.client_notice;
      if(n.result === 'sent') out.push({ ts: p.ts, cat: 'mail', k: 'told', who: p.charged_by_email, text: 'Client emailed the receipt at ' + esc(n.to || '') + (n.source === 'typed' ? ' <span class="ctwarn">(address typed, not from the record)</span>' : ''), meta: '' });
      else if(n.result === 'failed') out.push({ ts: p.ts, cat: 'mail', k: 'not_told', who: p.charged_by_email, red: true, text: 'Client email ' + (n.to ? 'to ' + esc(n.to) + ' ' : '') + '<b>failed</b>' + (n.detail ? ' — ' + esc(n.detail) : ''), meta: 'The client has not been told.' });
      else if(n.result === 'skipped') out.push({ ts: p.ts, cat: 'mail', k: 'not_told', who: p.charged_by_email, red: true, text: 'Client <b>not emailed</b> the receipt' + (n.detail || n.skip_reason ? ' — ' + esc(n.detail || n.skip_reason) : ''), meta: '' });
    }
  }
  /* documents with no event of their own */
  for(const d of docs){
    if(d.kind === 'refund_confirmation' || attIdsInEvents.has(d.id)) continue;
    if(d.kind === 'client_receipt'){ out.push({ ts: d.created_at, cat: 'doc', k: 'receipt', who: null, text: 'Speedy receipt for ' + money(d.amount || (payById[d.payment_id] || {}).amount) + ' filed', meta: (d.filed_hawksoft ? 'HawkSoft &#10003;' : 'HawkSoft did not take it') + ' · on the platform &#10003;', docId: d.id }); continue; }
    if(noteAttIds.has(d.id)) continue;   // shown on the note it came with
    out.push({ ts: d.created_at, cat: 'doc', k: 'upload', who: emailOf(d.uploaded_by), text: N(d.uploaded_by) + ' uploaded <a class="dlink" onclick="ClientTabs.preview(\'' + esc(d.id) + '\')">' + esc(typeLabel(d)) + '</a>' + (needsLabel(d) ? ' <span class="ctwarn">— still needs a label</span>' : ''),
      meta: [forLine(d, c), bytesLabel(d.bytes), d.filed_hawksoft ? 'HawkSoft &#10003;' : 'on the platform only'].filter(Boolean).join(' · ') });
  }
  /* events */
  for(const e of evs){
    const p = e.payload || {}; const who = N(e.actor); const pay = payOf(p);
    const k = e.kind; let row = null;
    switch(k){
      case 'payment.refunded': {
        const cn = p.client_notice || {};
        row = { cat: 'money', text: who + ' refunded <b>' + money(p.amount) + '</b>' + (p.partial ? ' of the ' + money(p.collected) + ' payment' : pay ? ' — ' + payRef(pay) : '') + (p.method === 'card' ? ' to the card' : ' in cash'),
          meta: [p.clover_refund_id ? 'Clover ' + esc(p.clover_refund_id) : '', p.reason_label || REASON[p.reason] || '', p.carrier === 'yes' ? 'carrier money returned' + (p.carrier_share != null && p.partial ? ' (' + money(p.carrier_share) + ')' : '') : p.carrier === 'no' ? 'carrier money NOT returned — Speedy absorbed it' : 'carrier money not back yet',
            p.fee_reversed ? first(p.commission_to, c) + '’s fee reversed ' + money(p.fee_reversed) : '', p.hawksoft_note ? 'HawkSoft note &#10003;' : 'HawkSoft note failed'].filter(Boolean).join(' · ') };
        out.push(Object.assign({ ts: e.ts, who: emailOf(e.actor), k: 'refund', ev: e }, row));
        if(cn.result === 'sent') out.push({ ts: e.ts, cat: 'mail', k: 'told', who: emailOf(e.actor), text: 'Client emailed about the refund at ' + esc(cn.to || ''), meta: cn.source === 'typed' ? 'address typed by ' + esc(first(cn.chosen_by, c)) + ', not from the record' : '' });
        else if(cn.result === 'failed') out.push({ ts: e.ts, cat: 'mail', k: 'not_told', who: emailOf(e.actor), red: true, text: 'Refund email to ' + esc(cn.to || '') + ' <b>failed</b>', meta: esc(cn.detail || '') });
        else if(cn.result === 'skipped') out.push({ ts: e.ts, cat: 'mail', k: 'not_told', who: emailOf(e.actor), red: true, text: 'Client <b>not told</b> about the refund' + (cn.skip_reason ? ' — “' + esc(cn.skip_reason) + '”' : ''), meta: 'Say who told them, or email the client from the Console when there is an address.' });
        row = null; break; }
      case 'refund.client_notified': row = { cat: 'mail', text: who + ' emailed the client about the refund at ' + esc(p.to || ''), meta: (p.source === 'typed' ? 'address typed, not from the record · ' : '') + 'sent afterwards' }; break;
      case 'refund.requested': row = { cat: 'money', k: 'refund_ask', text: who + ' asked for a refund of <b>' + money(p.amount) + '</b>' + (pay ? ' on ' + payRef(pay) : '') + ' — ' + (REASON[p.reason] || p.reason || ''), meta: [p.note ? '“' + esc(p.note) + '”' : '', 'went to the owner for a decision'].filter(Boolean).join(' · ') }; break;
      case 'refund.decided': row = { cat: 'money', text: who + (p.approved ? ' <b>approved</b> ' : ' <b>declined</b> ') + first(p.requested_by, c) + '’s refund request' + (p.approved && p.amount_changed ? ' for <b>' + money(p.approved_amount) + ' of the ' + money(p.amount) + ' asked</b>' : ' for ' + money(p.amount)), meta: p.note ? '“' + esc(p.note) + '”' : '' }; break;
      case 'refund.confirmation_filed': row = { cat: 'doc', text: who + ' made the <a class="dlink" onclick="ClientTabs.preview(\'' + esc(p.attachment_id) + '\')">' + (p.kind === 'void' ? 'cancellation' : 'refund') + ' confirmation (' + (p.lang === 'es' ? 'Español' : 'English') + ')</a> for the ' + money(p.amount) + (p.kind === 'void' ? ' cancelled charge' : ' refund'), meta: (p.filed_hawksoft ? 'HawkSoft took it' : 'HawkSoft did not take it') + (p.late ? ' · generated afterwards from the refund record' : '') }; break;
      case 'audit.submitted': row = { cat: 'review', k: 'submit', text: who + ' submitted ' + payRef(pay) + ' for review', meta: [p.carrier ? esc(p.carrier) + (p.carrier_amount != null ? ' ' + money(p.carrier_amount) : '') + (p.carrier_card ? ' paid from the ' + esc(p.carrier_card) + ' card' : '') : '', p.attachment_id ? '<a class="dlink" onclick="ClientTabs.preview(\'' + esc(p.attachment_id) + '\')">carrier receipt</a>' + (p.hawksoft_filed ? ' filed to HawkSoft' : ' on the platform') : '', 'waiting for the auditor'].filter(Boolean).join(' · ') }; break;
      case 'carrier_leg.completed': row = { cat: 'review', text: who + ' completed the audit on ' + payRef(pay), meta: [p.carrier ? esc(p.carrier) + (p.carrier_amount != null ? ' ' + money(p.carrier_amount) : '') + (p.carrier_card ? ' from the ' + esc(p.carrier_card) + ' card' : '') : '', p.attachment_id ? '<a class="dlink" onclick="ClientTabs.preview(\'' + esc(p.attachment_id) + '\')">carrier receipt</a>' + (p.hawksoft_filed ? ' filed to HawkSoft' : '') : ''].filter(Boolean).join(' · ') }; break;
      case 'carrier_leg.saved': row = { cat: 'review', text: who + ' saved the carrier details on ' + payRef(pay) + ' (not submitted yet)', meta: p.carrier ? esc(p.carrier) + (p.carrier_amount != null ? ' ' + money(p.carrier_amount) : '') : '' }; break;
      case 'carrier.zero_acknowledged': row = { cat: 'review', text: who + ' confirmed nothing was owed to ' + esc(p.carrier || 'the carrier') + ' on the ' + money(p.charge_amount) + ' ' + esc(p.purpose || 'payment').toLowerCase(), meta: p.retro ? 'recorded afterwards' : '' }; break;
      case 'audit.approved': row = { cat: 'review', k: 'approve', text: who + ' <b>approved</b> the audit on ' + payRef(pay), meta: [p.carrier ? esc(p.carrier) + ' ' + money(p.carrier_amount) : '', p.fee != null ? 'Speedy kept ' + money(p.fee) : '', p.after_sendback ? 'after a send-back' : ''].filter(Boolean).join(' · ') }; break;
      case 'audit.sent_back': row = { cat: 'review', k: 'sent_back', to: emailOf(p.submitted_by || p.owner), red: true, text: who + ' <b>sent back</b> ' + payRef(pay) + ' to ' + first(p.submitted_by || p.owner, c), meta: '“' + esc(p.reason || p.code_label || '') + '”' }; break;
      case 'audit.completed_by_other': row = { cat: 'review', text: who + ' completed the audit on ' + first(p.owner, c) + '’s ' + money(p.amount) + ' payment', meta: p.carrier ? esc(p.carrier) + ' ' + money(p.carrier_amount) : '' }; break;
      case 'audit.repaired': row = { cat: 'review', text: 'The audit on the ' + money(p.carrier_amount) + ' carrier payment was repaired', meta: esc(p.reason || '') }; break;
      case 'commission.reassigned': row = { cat: 'money', text: N(p.by) + ' moved the commission on the ' + money(p.amount) + ' payment from ' + first(p.from, c) + ' to ' + first(p.to, c), meta: '' }; break;
      case 'commission.shared': row = { cat: 'money', k: 'share', text: p.pct > 0
          ? N(p.by) + ' shared the commission on the ' + money(p.amount != null ? p.amount : p.fee) + (p.amount != null ? ' payment' : ' fee') + ' with <b>' + esc(first(p.helper, c)) + ' (' + Number(p.pct || 0) + '%)</b>' + (p.changed ? ' — changed' : '')
          : N(p.by) + ' removed the share on the ' + money(p.amount != null ? p.amount : p.fee) + ' payment' + (p.before && p.before.helper ? ' (was ' + esc(first(p.before.helper, c)) + ' ' + Number(p.before.pct || 0) + '%)' : ''),
        meta: [p.why ? '“' + esc(p.why) + '”' : '', p.by && p.owner && emailOf(p.by) !== emailOf(p.owner) ? 'on ' + esc(first(p.owner, c)) + '’s commission' : '', p.hawksoft_note ? 'HawkSoft note &#10003;' : ''].filter(Boolean).join(' · ') }; break;
      case 'client.correction_requested': row = { cat: 'money', text: who + ' asked to move the ' + money(p.amount) + ' payment from client #' + esc(p.from) + ' to #' + esc(p.to), meta: p.reason ? '“' + esc(p.reason) + '”' : '' }; break;
      case 'client.corrected': row = { cat: 'money', text: who + ' moved the ' + money(p.amount) + ' payment from client #' + esc(p.from) + ' to #' + esc(p.to), meta: [p.reason ? '“' + esc(p.reason) + '”' : '', p.hawksoft_notes ? 'HawkSoft notes on both clients &#10003;' : ''].filter(Boolean).join(' · ') }; break;
      case 'document.relabelled': row = { cat: 'doc', text: who + ' relabelled a document: ' + esc(labelOfType(p.before)) + ' &#8594; ' + esc(labelOfType(p.after)), meta: esc(p.filename || '') }; break;
      case 'document.hawksoft_refused': row = { cat: 'doc', red: true, text: 'HawkSoft <b>refused</b> a ' + esc(String(p.doc_type || 'document').replace(/_/g, ' ')) + ' (' + bytesLabel(p.bytes) + ')', meta: 'kept on the platform · ' + esc(String(p.why || '').replace(/^"|"$/g, '')) }; break;
      case 'payment.note_sent': row = { cat: 'other', text: 'Payment note written to the HawkSoft policy ' + esc(p.policy_number || ''), meta: '' }; break;
      case 'payment.policy_linked': row = { cat: 'other', text: 'The ' + money(p.amount) + ' payment was linked to policy ' + esc(p.policy_number || '') + (p.carrier ? ' (' + esc(p.carrier) + ')' : ''), meta: '' }; break;
      case 'client.synced': row = { cat: 'other', text: 'Client record synced from HawkSoft', meta: p.policies_synced != null ? p.policies_synced + ' polic' + (p.policies_synced === 1 ? 'y' : 'ies') : '' }; break;
      case 'note.added': row = { cat: 'note', k: 'note', text: who + ' noted:' + noteCardHtml(e, c), meta: '' }; break;
      case 'invoice.converted_from_placeholder': row = { cat: 'money', text: who + ' converted a placeholder into an open invoice', meta: [p.was ? 'was: ' + esc(p.was) : '', p.now ? 'now: ' + esc(p.now) : ''].filter(Boolean).join(' · ') }; break;
      case 'ledger.status_corrected': row = { cat: 'money', text: 'A ' + money(p.amount) + ' row was corrected from ' + esc(p.from_status) + ' to ' + esc(p.to_status), meta: esc(p.reason || '') }; break;
      case 'ledger.corrected': row = { cat: 'money', text: 'A payment row was corrected', meta: esc(p.note || '') }; break;
      case 'attachment.payment_id_backfilled': row = { cat: 'doc', text: 'A receipt was re-attached to its payment', meta: esc(p.filename || '') }; break;
      default: row = { cat: 'other', text: (e.actor && !/^(platform|system|cron)$/i.test(e.actor) ? who + ' · ' : '') + esc(String(k).replace(/[._]/g, ' ')), meta: '' };
    }
    if(row) out.push(Object.assign({ ts: e.ts, who: emailOf(e.actor), k: row.k || k, ev: e }, row));
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  /* REPLIES nest under the note they answer (the mock's thread) when the parent is here */
  const byId = {}; out.forEach(x => { if(x.ev && x.ev.kind === 'note.added') byId[x.ev.id] = x; });
  const top = [];
  for(const x of out){
    const rt = x.ev && x.ev.kind === 'note.added' && x.ev.payload && x.ev.payload.reply_to;
    if(rt && byId[rt] && byId[rt] !== x){ (byId[rt].replies = byId[rt].replies || []).push(x); x.nested = true; }
    else top.push(x);
  }
  top.forEach(x => { if(x.replies) x.replies.sort((a, b) => String(a.ts).localeCompare(String(b.ts))); });
  return top;
}
/* the plain address behind "Name (email)" or an email */
function emailOf(v){ const m = String(v || '').match(/[a-z0-9._-]+@[a-z0-9.-]+/i); return m ? m[0].toLowerCase() : null; }
/* THE NOTE CARD: the words, what it is about (chips), its attachments as thumbnails, Reply. */
function noteCardHtml(e, c){
  const p = e.payload || {};
  const docs = c.documents || [];
  const chips = [];
  if(p.policy_number) chips.push('about policy ' + esc(p.policy_number));
  for(const a of (Array.isArray(p.about) ? p.about : [])){
    if(a.type === 'payment'){ const pay = (c.payments || []).find(x => x.id === a.id); chips.push('about ' + (pay ? 'the ' + money(pay.amount) + ' payment of ' + t(pay.ts, { month: 'short', day: 'numeric' }) : esc(a.label || 'a payment'))); }
    else if(a.type === 'document'){ const d = docs.find(x => x.id === a.id); chips.push('about <a class="dlink" onclick="event.stopPropagation();ClientTabs.preview(\'' + esc(a.id) + '\')">' + esc(d ? typeLabel(d) : (a.label || 'a document')) + '</a>'); }
    else if(a.type === 'policy'){ if(!p.policy_number || a.id !== p.policy_number) chips.push('about policy ' + esc(a.id)); }
    else if(a.type === 'note'){ chips.push('&#8627; about <a class="dlink" onclick="event.stopPropagation();ClientTabs.jump(\'' + esc(a.id) + '\')">' + esc(a.label || 'an earlier note') + '</a>'); }
  }
  if(p.reply_to) chips.push('&#8627; reply' + (p.reply_to_label ? ' to ' + esc(p.reply_to_label) : ''));
  chips.push(p.hawksoft_note ? 'HawkSoft &#10003;' : 'not in HawkSoft');
  const atts = (Array.isArray(p.attachments) ? p.attachments : []).map(id => docs.find(x => x.id === id) || { id, missing: true });
  const acts = CUR && CUR.opts && CUR.opts.notes !== false
    ? '<div class="nacts"><span onclick="event.stopPropagation();ClientTabs.replyTo(\'' + esc(e.id) + '\')">Reply</span></div>' : '';
  return '<div class="ncard" id="note-' + esc(e.id) + '"><div class="nt">' + esc(p.text || '') + '</div>'
    + '<div class="nchips">' + chips.map(x => '<span class="nchip">' + x + '</span>').join('') + '</div>'
    + (atts.length ? '<div class="natts">' + atts.map(d => d.missing ? '' : '<div class="natt" onclick="event.stopPropagation();ClientTabs.preview(\'' + esc(d.id) + '\')" title="' + esc(d.filename || typeLabel(d)) + '">' + thumbBox(d, c) + '<span>' + esc(d.filename || typeLabel(d)) + '</span></div>').join('') + '</div>' : '')
    + acts + '</div>';
}
function jump(id){ const el = document.getElementById('note-' + id); if(el){ el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); } }
function labelOfType(x){ if(!x) return '?'; return typeLabel({ doc_type: x.doc_type, doc_label: x.doc_label }); }
const FILTERS = [['all', 'All'], ['money', 'Money'], ['doc', 'Documents'], ['mail', 'Client emails'], ['review', 'Reviews'], ['note', 'Notes']];
const LOGF = {};
const NOTEBOX = {};   // client_no -> { text, policy, about:[{type,id,label}], files:[File], reply_to, reply_label }
function logHtml(c, opts){
  const no = opts.clientNo || (c.client && c.client.client_no);
  const f = LOGF[no] || 'all';
  const all = logEntries(c);
  const list0 = f === 'all' ? all : all.filter(e => e.cat === f);
  const list = sortKey('log') === 'oldest' ? list0.slice().reverse() : list0;
  let h = '<div class="ctlog">';
  if(opts.notes !== false){
    const nb = NOTEBOX[no] || (NOTEBOX[no] = { about: [], files: [], reply_to: null, reply_label: '' });
    h += '<div class="notebox" id="ctNoteBox">'
      + (nb.reply_to ? '<div class="nreplying">&#8627; Replying to ' + esc(nb.reply_label || 'a note') + ' <span class="dlink" onclick="ClientTabs.replyTo(null)">cancel</span></div>' : '')
      + '<textarea id="ctNote" class="ctin" rows="2" maxlength="600" placeholder="' + (nb.reply_to ? 'Your reply…' : 'Add a note about this client — it goes in this log and on the HawkSoft client log') + '">' + esc(nb.text || '') + '</textarea>'
      + (nb.about.length || nb.files.length ? '<div class="nchips" style="margin-top:6px">'
          + nb.about.map((a, i) => '<span class="nchip">' + esc(a.label) + ' <i onclick="ClientTabs.unlink(' + Number(no) + ',' + i + ')">&#10005;</i></span>').join('')
          + nb.files.map((f, i) => '<span class="nchip file">&#128206; ' + esc(f.name) + ' · ' + bytesLabel(f.size) + ' <i onclick="ClientTabs.unfile(' + Number(no) + ',' + i + ')">&#10005;</i></span>').join('')
          + '</div>' : '')
      + '<div class="noterow">'
      + ((c.policies || []).filter(p => p.policy_number).length
          ? '<select id="ctNotePol" class="ctsel"><option value="">About the client</option>' + (c.policies || []).filter(p => p.policy_number).map(p => '<option value="' + esc(p.policy_number) + '"' + (nb.policy === p.policy_number ? ' selected' : '') + '>' + esc((p.carrier || '') + ' ' + p.policy_number) + '</option>').join('') + '</select>' : '<span></span>')
      + '<span class="ntools"><label class="nlink" title="Attach photos or files">&#128206; Attach<input type="file" multiple accept="image/*,application/pdf" style="display:none" onchange="ClientTabs.pickFiles(' + Number(no) + ', this.files)"></label>'
      + '<span class="nlink" onclick="ClientTabs.linkTo(' + Number(no) + ')">&#128279; Link to…</span>'
      + '<span class="noteok" onclick="ClientTabs.addNote(' + Number(no) + ')">' + (nb.reply_to ? 'Reply' : 'Add note') + '</span></span></div><div class="msg" id="ctNoteMsg">' + esc(nb.msg || '') + '</div></div>';
    nb.msg = '';
  }
  h += '<div class="lfil">' + FILTERS.map(([k, l]) => '<span class="' + (f === k ? 'on' : '') + '" onclick="ClientTabs.filter(' + Number(no) + ',\'' + k + '\')">' + l + '</span>').join('')
    + sortHtml('log', [['newest', 'Newest first'], ['oldest', 'Oldest first']], 'ClientTabs.sort') + '</div>';
  if(!list.length) h += '<div class="dnone">Nothing here yet.</div>';
  let day = null;
  const rowHtml = e => '<div class="lrow"><div class="when">' + esc(timeOnly(e.ts)) + '</div><div class="dot ' + (e.red ? 'red' : 'd-' + e.cat) + '"></div><div class="w">' + e.text + (e.meta ? '<span class="m">' + e.meta + '</span>' : '')
    + ((e.replies || []).length ? '<div class="nreplies">' + e.replies.map(r => '<div class="nreply"><span class="rwhen">' + esc(whenShort(r.ts)) + '</span>' + r.text + '</div>').join('') + '</div>' : '') + '</div></div>';
  for(const e of list){
    const dk = dayKey(e.ts);
    if(dk !== day){ day = dk; h += '<div class="lday">' + esc(dayLabel(e.ts)) + '</div>'; }
    h += rowHtml(e);
  }
  setTimeout(() => fillThumbs(no, c, '.ctlog'), 0);
  h += '<div class="lnote">Everything the platform did on this client, in order. What happened in HawkSoft directly (CMS notes, calls) is not here.</div></div>';
  return h;
}
function filter(no, f){ LOGF[no] = f; if(CUR && CUR.opts.rerender) CUR.opts.rerender(no); }
const NOTE_FILE_MAX = 3 * 1024 * 1024;
function keepBox(no){ const ta = document.getElementById('ctNote'), pol = document.getElementById('ctNotePol'); const nb = NOTEBOX[no] || (NOTEBOX[no] = { about: [], files: [], reply_to: null }); if(ta) nb.text = ta.value; if(pol) nb.policy = pol.value; return nb; }
function pickFiles(no, files){
  const nb = keepBox(no);
  for(const f of [...(files || [])]){
    if(f.size > NOTE_FILE_MAX){ nb.msg = f.name + ' is over 3 MB — add it with "Add documents to this client" instead.'; continue; }   // shown after the re-render
    nb.files.push(f);
  }
  if(CUR && CUR.opts.rerender) CUR.opts.rerender(no);
}
function unfile(no, i){ const nb = keepBox(no); nb.files.splice(i, 1); if(CUR && CUR.opts.rerender) CUR.opts.rerender(no); }
function unlink(no, i){ const nb = keepBox(no); nb.about.splice(i, 1); if(CUR && CUR.opts.rerender) CUR.opts.rerender(no); }
function replyTo(id){
  const c = CUR && CUR.c; const no = CUR && CUR.opts.clientNo;
  const nb = keepBox(no);
  if(!id){ nb.reply_to = null; nb.reply_label = ''; }
  else {
    const e = ((c && c.events) || []).find(x => x.id === id);
    nb.reply_to = id; nb.reply_label = e ? first(e.actor, c) + '\u2019s note of ' + t(e.ts, { month: 'short', day: 'numeric' }) : 'a note';
  }
  if(CUR && CUR.opts.rerender) CUR.opts.rerender(no);
  setTimeout(() => { const ta = document.getElementById('ctNote'); if(ta) ta.focus(); }, 0);
}
/* "Link to…": what on this client the note is about - payments, documents, policies, earlier notes */
function linkTo(no){
  const c = CUR && CUR.c; const nb = keepBox(no);
  const old = document.getElementById('ctLink'); if(old) old.remove();
  const opts = [];
  for(const p of (c.payments || [])) opts.push({ type: 'payment', id: p.id, label: (p.refund_of ? 'the refund of ' : 'the ' + money(p.amount) + ' payment of ') + t(p.ts, { month: 'short', day: 'numeric' }) + (p.purpose && !p.refund_of ? ' · ' + p.purpose : '') });
  for(const d of (c.documents || [])) opts.push({ type: 'document', id: d.id, label: typeLabel(d) + ' · ' + t(d.created_at, { month: 'short', day: 'numeric' }) });
  for(const p of (c.policies || [])) if(p.policy_number) opts.push({ type: 'policy', id: p.policy_number, label: 'policy ' + (p.carrier ? p.carrier + ' ' : '') + p.policy_number });
  for(const e of (c.events || [])) if(e.kind === 'note.added') opts.push({ type: 'note', id: e.id, label: first(e.actor, c) + '\u2019s note of ' + t(e.ts, { month: 'short', day: 'numeric' }) + ': \u201c' + String((e.payload || {}).text || '').slice(0, 40) + (String((e.payload || {}).text || '').length > 40 ? '…' : '') + '\u201d' });
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'ctLink';
  box.innerHTML = '<div class="ctpanel small"><div class="hd"><b>What is this note about?</b><span class="x" onclick="document.getElementById(\'ctLink\').remove()">&#10005;</span></div>'
    + '<div class="nlist">' + (opts.length ? opts.map((o, i) => '<div class="nopt' + (nb.about.some(a => a.type === o.type && a.id === o.id) ? ' on' : '') + '" data-i="' + i + '"><span class="nk">' + o.type + '</span>' + esc(o.label) + '</div>').join('') : '<div class="dim" style="padding:12px 14px">Nothing on this client to link to yet.</div>') + '</div>'
    + '<div class="btns"><span class="ok" id="ctLinkOk">Done</span></div></div>';
  document.body.appendChild(box);
  box.querySelectorAll('.nopt').forEach(el => el.onclick = () => {
    const o = opts[Number(el.dataset.i)]; const j = nb.about.findIndex(a => a.type === o.type && a.id === o.id);
    if(j >= 0){ nb.about.splice(j, 1); el.classList.remove('on'); } else { nb.about.push({ type: o.type, id: o.id, label: o.label }); el.classList.add('on'); }
  });
  document.getElementById('ctLinkOk').onclick = () => { box.remove(); if(CUR && CUR.opts.rerender) CUR.opts.rerender(no); };
}
/* a photo shrinks to 1600px and gets a 240px thumbnail, like the carrier page; a PDF gets page 1 */
function readDataUrl(f){ return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('read failed')); r.readAsDataURL(f); }); }
async function prepNoteFile(f){
  if(/^image\//i.test(f.type)){
    try{
      const url = URL.createObjectURL(f);
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('bad image')); i.src = url; });
      const draw = (edge, q) => { const sc = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight)); const cv = document.createElement('canvas'); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); return cv.toDataURL('image/jpeg', q); };
      const full = draw(1600, 0.82), thumb = draw(240, 0.6); URL.revokeObjectURL(url);
      return { b64: full, thumb, name: f.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg' };
    }catch(e){ return { b64: await readDataUrl(f), thumb: null, name: f.name, mime: f.type }; }
  }
  const b64 = await readDataUrl(f);
  let thumb = null; try{ thumb = await window.ClientTabs.pdfFirstPage(b64); }catch(e){ thumb = null; }
  return { b64, thumb, name: f.name, mime: f.type || 'application/pdf' };
}
async function addNote(no){
  const nb = keepBox(no); const msg = document.getElementById('ctNoteMsg');
  const text = String(nb.text || '').trim();
  if(!text){ if(msg) msg.textContent = 'Write the note first.'; return; }
  const c = CUR && CUR.c;
  const when = t(new Date().toISOString(), { month: 'short', day: 'numeric' });
  const who = CUR && CUR.opts.me ? first(CUR.opts.me, c) : 'a note';
  /* the files first: each becomes a document on the client (no payment), labelled as
     this note's; the note then names them by id. A file that fails stops the note -
     a note that says "2 attachments" with one missing is worse than no note. */
  const attachments = [];
  for(let i = 0; i < nb.files.length; i++){
    const f = nb.files[i];
    if(msg) msg.textContent = 'Uploading ' + f.name + ' (' + (i + 1) + ' of ' + nb.files.length + ')…';
    let prep; try{ prep = await window.ClientTabs.prepNoteFile(f); /* through the export, like pdfFirstPage */ }catch(e){ if(msg) msg.textContent = f.name + ' could not be read.'; return; }
    const r = await carrierPost({ action: 'add_document', client_no: no, no_payment: true, doc_type: 'other', doc_label: ('Note ' + who + ' ' + when).slice(0, 41),
      receipt_b64: prep.b64, receipt_name: prep.name, receipt_mime: prep.mime, thumb_b64: prep.thumb });
    if(!r || !r.ok || !r.attachment_id){ if(msg) msg.textContent = f.name + ': ' + ((r && (r.message || r.error)) || 'upload failed') + '. The note was not saved.'; return; }
    attachments.push(r.attachment_id);
    if(c){ c.documents = c.documents || []; c.documents.unshift({ id: r.attachment_id, payment_id: null, kind: 'other', doc_type: 'other', doc_label: ('Note ' + who + ' ' + when).slice(0, 41), filename: prep.name, bytes: r.bytes || f.size, mime: prep.mime, filed_hawksoft: !!r.hawksoft_filed, created_at: new Date().toISOString(), uploaded_by: CUR.opts.me }); }
  }
  if(msg) msg.textContent = 'Saving…';
  const post = window.apiPostBody || window.apiPost;
  const r = await post({ action: 'add_note', client_no: no, text, policy_number: nb.policy || '', about: nb.about.map(a => ({ type: a.type, id: a.id, label: a.label })), attachments, reply_to: nb.reply_to || null, source: window.apiPostBody ? 'console' : 'portal' });
  if(!r || !r.ok){ if(msg) msg.textContent = (r && r.error) || 'Could not save the note.'; return; }
  if(c){ c.events = c.events || []; c.events.unshift({ id: r.id, ts: r.ts || new Date().toISOString(), actor: CUR.opts.me, kind: 'note.added', payload: { text, policy_number: nb.policy || '', about: nb.about, attachments, reply_to: nb.reply_to || null, reply_to_label: nb.reply_label || null, hawksoft_note: !!r.hawksoft_note } }); }
  NOTEBOX[no] = { about: [], files: [], reply_to: null, text: '', policy: '' };
  if(CUR && CUR.opts.rerender) CUR.opts.rerender(no);
}

window.ClientTabs = { html, set, current, docsHtml, logHtml, logEntries, preview, menu, relabel, upload, uploadUrl, addNote, thumbBox, setThumb, carrierPost, pageToken, forLine, bytesLabel, canRelabel, RELABEL, sort: setSort, sortRows, sortHtml, sortKey, SORTS, DOC_SORT_KEYS, DOC_SORT_FIELDS, pickFiles, unfile, unlink, replyTo, linkTo, jump, noteCardHtml, emailOf, prepNoteFile, filter, needsLabel, groupOf, typeLabel, nameOf, fillThumbs, pdfFirstPage };
})();
