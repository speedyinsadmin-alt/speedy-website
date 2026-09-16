/* THE DOCUMENT CENTER (Sep 16) — every document the platform holds, across clients.
   Console → Documents: search (client, number, file name, label), type chips with
   counts, who / branch / range, the tiles, the cards (same thumbnails as the client
   page), and on the right the queues that need a human: payments with no proof yet,
   needs a label, not in HawkSoft (over 5 MB vs refused, with retry). Portal → "My
   documents": the same held to the agent's own uploads and payments.
   Reads the `documents` view (metadata only) and does the grouping, searching and
   counting here — a month is a few hundred rows. Every label, group and thumbnail comes
   from ClientTabs, so a document reads the same here as on its client. Loaded after
   clienttabs.js on both pages. */
(function(){
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const money = n => { const v = Number(n||0); return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
function t(ts, o){ try { return new Date(ts).toLocaleString('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, o)); } catch(e){ return String(ts || '').slice(0, 16); } }
const whenShort = ts => t(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayKey = ts => t(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = ts => t(ts, { weekday: 'long', month: 'short', day: 'numeric' });
function todayPT(){ return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
function shift(d, n){ const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function rangeFor(preset){
  const to = todayPT();
  if(preset === 'week'){ const dow = new Date(to + 'T12:00:00Z').getUTCDay(); return { from: shift(to, -((dow + 6) % 7)), to }; }
  if(preset === 'quarter') return { from: shift(to, -90), to };
  return { from: to.slice(0, 8) + '01', to };
}
const HS_MAX = 5 * 1024 * 1024;
const GROUPS = [['receipts', 'Receipts & slips'], ['carrier', 'Carrier receipts'], ['signed', 'Signed paperwork'], ['id', 'ID & photos'], ['other', 'Other']];
/* the state of the page: range, filters, the last data */
const F = { preset: 'month', from: null, to: null, q: '', type: 'all', who: 'all', branch: 'all', only: null /* 'nohs' | 'label' */, shown: 60 };
let DATA = null;
const range = () => (F.preset === 'custom' && F.from && F.to) ? { from: F.from, to: F.to } : rangeFor(F.preset);
function fmtRange(r){ const f = t(r.from + 'T12:00:00Z', { month: 'short', day: 'numeric' }), g = t(r.to + 'T12:00:00Z', { month: 'short', day: 'numeric' }); return f === g ? f : f + ' – ' + g; }

/* ---------- the rows, decorated ---------- */
function docsOf(data){
  const names = data.client_names || {}, pays = data.payments || {};
  return (data.documents || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).map(d => Object.assign({}, d, {
    client_name: names[d.client_no] || ('Client #' + d.client_no),
    pay: d.payment_id ? pays[d.payment_id] || null : null,
    group: window.ClientTabs.groupOf(d), needs: window.ClientTabs.needsLabel(d),
    nohs: !d.filed_hawksoft && d.kind !== 'client_receipt' && d.kind !== 'refund_confirmation' ? (Number(d.bytes || 0) > HS_MAX ? 'big' : 'refused') : null,
  }));
}
function matches(d, q){
  if(!q) return true;
  const hay = [d.client_name, String(d.client_no), d.filename, d.doc_label, window.ClientTabs.typeLabel(d)].join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function filtered(all){
  const q = F.q.trim().toLowerCase();
  const roster = (DATA && DATA.roster) || [];
  const branchEmails = F.branch === 'all' ? null : new Set(roster.filter(a => a.branch === F.branch).map(a => a.email));
  return all.filter(d => matches(d, q)
    && (F.type === 'all' || d.group === F.type)
    && (F.who === 'all' || String(d.uploaded_by || '').toLowerCase().includes(F.who))
    && (!branchEmails || [...branchEmails].some(e => String(d.uploaded_by || '').toLowerCase().includes(e)))
    && (F.only !== 'nohs' || d.nohs) && (F.only !== 'label' || d.needs));
}
/* the pseudo-card a document's client would have, so ClientTabs draws it the same */
const cardFor = d => ({ client: { client_no: d.client_no }, payments: d.pay ? [d.pay] : [], documents: [d], agent_names: (DATA && DATA.agent_names) || {} });
function cardHtml(d, opts){
  const CT = window.ClientTabs;
  const who = (d.uploaded_by === 'platform' || d.uploaded_by === 'charge_page') ? 'the platform' : CT.nameOf(d.uploaded_by, cardFor(d));
  const madeBy = d.kind === 'client_receipt' || d.kind === 'refund_confirmation';
  const hs = d.filed_hawksoft ? '<span class="hs">&#10003; HawkSoft</span>' : (d.nohs === 'big' ? '<span class="hs no">over the 5 MB limit</span>' : madeBy ? '<span class="hs no">not in HawkSoft</span>' : '<span class="hs no">on the platform only</span>');
  const title = CT.typeLabel(d) + (d.needs ? ' · <span class="nl">needs a label</span>' : '');
  const forWhat = d.pay ? (d.pay.refund_of ? 'for the ' + (d.pay.voided ? 'cancelled charge' : 'refund') + ' of ' + t(d.pay.ts, { month: 'short', day: 'numeric' }) : (d.kind === 'proof' || d.doc_type === 'carrier_receipt' ? 'proves' : 'for') + ' the ' + money(d.pay.amount) + ' payment of ' + t(d.pay.ts, { month: 'short', day: 'numeric' })) : '';
  return '<div class="dcdoc" data-id="' + esc(d.id) + '" onclick="DocCenter.preview(\'' + esc(d.id) + '\')">' + CT.thumbBox(d, cardFor(d))
    + '<div class="b"><div class="t" title="' + esc(d.filename || '') + '">' + title + '</div>'
    + '<div class="s"><a class="dlink" onclick="event.stopPropagation();DocCenter.goClient(' + Number(d.client_no) + ')">' + esc(d.client_name) + '</a> #' + esc(d.client_no) + ' · ' + esc(whenShort(d.created_at)) + ' · ' + (madeBy ? 'for ' : '') + esc(who) + (forWhat ? ' · ' + forWhat : '') + (d.bytes ? ' · ' + CT.bytesLabel(d.bytes) : '') + ' · ' + hs
    + (opts.actions && d.nohs === 'refused' ? ' · <a class="dlink" onclick="event.stopPropagation();DocCenter.retry(\'' + esc(d.id) + '\')">retry HawkSoft</a>' : '')
    + (opts.actions && d.needs && CT.canRelabel(d) ? ' · <a class="dlink" onclick="event.stopPropagation();DocCenter.relabel(\'' + esc(d.id) + '\')">say what it is</a>' : '')
    + '</div></div></div>';
}
function chipsHtml(all, fn){
  const P = [['week', 'This week'], ['month', 'This month'], ['quarter', 'Last 90 days'], ['custom', 'Pick dates…']];
  return '<div class="lfil arange">' + P.map(([k, l]) => '<span class="' + (F.preset === k ? 'on' : '') + '" onclick="DocCenter.preset(\'' + k + '\')">' + l + '</span>').join('') + '<span class="dates">' + esc(fmtRange(range())) + '</span></div>'
    + (F.preset === 'custom' ? '<div class="adates"><input type="date" id="dcFrom" value="' + esc(F.from || range().from) + '"> <span class="dim">to</span> <input type="date" id="dcTo" value="' + esc(F.to || range().to) + '"> <span class="noteok" onclick="DocCenter.applyDates()">Show</span></div>' : '');
}
function typeChips(all){
  const n = g => all.filter(d => d.group === g).length;
  const nohs = all.filter(d => d.nohs).length, needs = all.filter(d => d.needs).length;
  return '<div class="lfil dctypes"><span class="' + (F.type === 'all' && !F.only ? 'on' : '') + '" onclick="DocCenter.type(\'all\')">All <i>' + all.length + '</i></span>'
    + GROUPS.map(([g, l]) => '<span class="' + (F.type === g && !F.only ? 'on' : '') + '" onclick="DocCenter.type(\'' + g + '\')">' + l + ' <i>' + n(g) + '</i></span>').join('')
    + '<span class="gap"></span><span class="' + (F.only === 'nohs' ? 'on' : '') + '" onclick="DocCenter.only(\'nohs\')">Not in HawkSoft <i>' + nohs + '</i></span><span class="' + (F.only === 'label' ? 'on' : '') + '" onclick="DocCenter.only(\'label\')">Needs a label <i>' + needs + '</i></span></div>';
}
function tilesHtml(all, data){
  const wk = rangeFor('week'); const wkT0 = new Date(wk.from + 'T07:00:00Z').getTime();
  const week = all.filter(d => new Date(d.created_at).getTime() >= wkT0);
  const agents = new Set(week.map(d => (String(d.uploaded_by || '').toLowerCase().match(/[a-z0-9._-]+@[a-z0-9.-]+/) || [])[0]).filter(Boolean));   // "Name (email)" and "email" are the same person
  const needs = all.filter(d => d.needs).length, big = all.filter(d => d.nohs === 'big').length, refused = all.filter(d => d.nohs === 'refused').length;
  const noProof = ((data.queues || {}).no_proof || []).length;
  const tile = (v, l, cls, fn) => '<div class="atile' + (cls ? ' ' + cls : '') + '"' + (fn ? ' onclick="' + fn + '" style="cursor:pointer"' : '') + '><b>' + v + '</b><span>' + l + '</span></div>';
  return '<div class="atiles dc">' + tile(all.length, 'documents · ' + esc(fmtRange(range()))) + tile(week.length, 'uploaded this week' + (agents.size ? ' · ' + agents.size + ' agent' + (agents.size === 1 ? '' : 's') : ''))
    + tile(needs, 'need a label', needs ? 'warn' : '', "DocCenter.only('label')") + tile(big + refused, 'not in HawkSoft' + (big + refused ? ' (' + big + ' over 5 MB, ' + refused + ' refused)' : ''), (big + refused) ? 'warn' : '', "DocCenter.only('nohs')")
    + (data.queues ? tile(noProof, 'payments with no proof yet', noProof ? 'red' : '') : '') + '</div>';
}
function queuesHtml(all, data){
  const q = data.queues || {}; const names = data.client_names || {};
  const days = ts => Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000));
  const row = (a, b) => '<div class="row"><span>' + a + '</span><span class="m">' + b + '</span></div>';
  const np = (q.no_proof || []);
  let h = '<div class="dcside">';
  h += '<div class="box' + (np.length ? ' red' : '') + '"><div class="h">Payments with no proof yet <span>' + np.length + '</span></div>'
    + (np.length ? np.slice(0, 6).map(p => row('<a class="dlink" onclick="DocCenter.goClient(' + Number(p.client_no) + ')">' + esc(names[p.client_no] || ('#' + p.client_no)) + '</a> · ' + money(p.amount) + ' · ' + esc(t(p.ts, { month: 'short', day: 'numeric' })), esc(String(p.agent_name || '').split(' ')[0]) + ' · ' + days(p.ts) + ' day' + (days(p.ts) === 1 ? '' : 's'))).join('') + (np.length > 6 ? row('<span class="m">+' + (np.length - 6) + ' more</span>', '') : '') : '<div class="dnone">None — every payment in the last 60 days has its proof or its audit.</div>') + '</div>';
  const nl = all.filter(d => d.needs);
  h += '<div class="box' + (nl.length ? ' warn' : '') + '"><div class="h">Needs a label <span>' + nl.length + '</span></div>'
    + (nl.length ? nl.slice(0, 6).map(d => row('<a class="dlink" onclick="DocCenter.goClient(' + Number(d.client_no) + ')">' + esc(d.client_name) + '</a> · ' + esc(window.ClientTabs.typeLabel(d)), esc(String(window.ClientTabs.nameOf(d.uploaded_by, cardFor(d))).split(' ')[0]) + ' · ' + esc(t(d.created_at, { month: 'short', day: 'numeric' })))).join('') + (nl.length > 6 ? row('<span class="m">+' + (nl.length - 6) + ' more · fix from the client’s Documents tab</span>', '') : '') : '<div class="dnone">None in this range.</div>') + '</div>';
  const big = all.filter(d => d.nohs === 'big').length, refused = all.filter(d => d.nohs === 'refused');
  h += '<div class="box' + ((big + refused.length) ? ' warn' : '') + '"><div class="h">Not in HawkSoft <span>' + (big + refused.length) + '</span></div>' + row('Over the 5 MB limit', String(big)) + row('Refused or failed', String(refused.length) + (refused.length ? ' · <a class="dlink" onclick="DocCenter.only(\'nohs\')">show</a>' : '')) + '</div>';
  h += '<div class="box"><div class="h">By type <span>' + esc(fmtRange(range())) + '</span></div>' + GROUPS.map(([g, l]) => row(l, String(all.filter(d => d.group === g).length))).join('') + '</div>';
  if(data.is_admin){
    const by = {}; for(const d of all){ const e = String(d.uploaded_by || '').toLowerCase(); if(!/@/.test(e) || /platform|charge_page/.test(e)) continue; const em = (e.match(/[a-z0-9._-]+@[a-z0-9.-]+/) || [])[0]; if(em) by[em] = (by[em] || 0) + 1; }
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6);
    h += '<div class="box"><div class="h">Who uploads <span>' + esc(fmtRange(range())) + '</span></div>' + (top.length ? top.map(([e, n]) => row(esc((data.agent_names || {})[e] || e), String(n))).join('') : '<div class="dnone">Nothing yet.</div>') + '</div>';
  }
  return h + '</div>';
}
function listHtml(list, opts){
  if(!list.length) return '<div class="dnone">No documents match.</div>';
  let h = '', day = null, n = 0;
  for(const d of list){
    if(n++ >= F.shown) break;
    const dk = dayKey(d.created_at);
    if(dk !== day){ h += (day ? '</div>' : '') + '<div class="lday">' + esc(dayLabel(d.created_at)) + '</div><div class="dcgrid">'; day = dk; }
    h += cardHtml(d, opts);
  }
  if(day) h += '</div>';
  if(list.length > F.shown) h += '<div class="dcmore"><span class="dlink" onclick="DocCenter.more()">Show more</span> · ' + Math.min(F.shown, list.length) + ' of ' + list.length + '</div>';
  return h;
}
function html(data, opts){
  opts = Object.assign({ actions: true, mine: false }, opts || {});
  DATA = data;   // the filters, the search box and the actions all read the data last drawn
  const all = docsOf(data); const list = filtered(all);
  const roster = data.roster || []; const branches = [...new Set(roster.map(a => a.branch).filter(Boolean))].sort();
  let h = '<div class="ctlog act dc" id="dcRoot">';
  h += '<div class="dctop"><div class="dcsearch"><span class="dim">&#128269;</span><input id="dcQ" class="ctin" placeholder="' + (opts.mine ? 'Search my uploads — client, number, file name' : 'Search — client name or number, file name, label') + '" value="' + esc(F.q) + '" oninput="DocCenter.search(this.value)"></div>'
    + (data.is_admin ? '<select class="ctsel" onchange="DocCenter.who(this.value)"><option value="all">Anyone</option>' + roster.map(a => '<option value="' + esc(a.email) + '"' + (F.who === a.email ? ' selected' : '') + '>' + esc(a.full_name || a.email) + '</option>').join('') + '</select>'
      + '<select class="ctsel" onchange="DocCenter.branch(this.value)"><option value="all">All branches</option>' + branches.map(b => '<option' + (F.branch === b ? ' selected' : '') + '>' + esc(b) + '</option>').join('') + '</select>' : '')
    + '<span class="abtn" onclick="DocCenter.download()">&#11015; Export list (CSV)</span></div>';
  h += chipsHtml(all) + typeChips(all) + tilesHtml(all, data);
  h += '<div class="dccols"><div>' + (F.q ? '<div class="lday">Results for “' + esc(F.q) + '” · ' + list.length + '</div>' : '') + listHtml(list, opts) + '</div>' + queuesHtml(all, data) + '</div>';
  h += '<div class="lnote">Every document the platform holds, since Sep 5 2026. Documents from before that live in HawkSoft only — HawkSoft cannot be read back from here. Not here yet: reading a document’s text (OCR), e-signature, sharing with clients, retention.</div></div>';
  setTimeout(() => fillThumbs(list.slice(0, F.shown)), 0);
  return h;
}

/* ---------- thumbnails across clients: one call for the visible ids, then draw the PDFs that have none ---------- */
async function fillThumbs(list){
  const CT = window.ClientTabs;
  const ids = list.filter(d => !(d.kind === 'client_receipt' || d.kind === 'refund_confirmation')).map(d => d.id);
  const have = new Set();
  for(let i = 0; i < ids.length; i += 60){
    try{ const r = await window.api('doc_thumbs&ids=' + ids.slice(i, i + 60).join(',')); ((r && r.thumbs) || []).forEach(x => { have.add(x.id); CT.setThumb(x.id, x.thumb_b64); }); }catch(e){}
  }
  const todo = list.filter(d => /pdf/i.test(String(d.mime || '')) && !have.has(d.id) && !(d.kind === 'client_receipt' || d.kind === 'refund_confirmation') && Number(d.bytes || 0) <= 8 * 1024 * 1024).slice(0, 6);
  for(const d of todo){
    try{
      const r = await window.api('portal_doc&id=' + encodeURIComponent(d.id));
      if(!r || !r.ok || !r.file_b64) continue;
      const url = await CT.pdfFirstPage(r.file_b64);
      if(!url) continue;
      CT.setThumb(d.id, url);
      CT.carrierPost({ action: 'set_thumb', attachment_id: d.id, thumb_b64: url });
    }catch(e){}
  }
}

/* ---------- actions ---------- */
let RERENDER = null;
function rerender(){ if(typeof RERENDER === 'function') RERENDER(); }
function search(v){ F.q = String(v || ''); F.shown = 60; const root = document.getElementById('dcRoot'); if(!root) return; /* re-draw the list only, so the box keeps focus */ const list = filtered(docsOf(DATA)); const cols = root.querySelector('.dccols > div'); if(cols) cols.innerHTML = (F.q ? '<div class="lday">Results for “' + esc(F.q) + '” · ' + list.length + '</div>' : '') + listHtml(list, { actions: DATA.is_admin || true }); setTimeout(() => fillThumbs(list.slice(0, F.shown)), 0); }
function type(g){ F.type = g; F.only = null; F.shown = 60; rerender(); }
function only(k){ F.only = F.only === k ? null : k; F.type = 'all'; F.shown = 60; rerender(); }
function who(v){ F.who = v || 'all'; rerender(); }
function branch(v){ F.branch = v || 'all'; rerender(); }
function more(){ F.shown += 60; rerender(); }
function preset(k){ F.preset = k; if(k !== 'custom'){ F.from = F.to = null; load(); } else rerender(); }
function applyDates(){ const f = document.getElementById('dcFrom'), g = document.getElementById('dcTo'); if(!f || !g || !f.value || !g.value) return; F.preset = 'custom'; F.from = f.value; F.to = g.value; load(); }
function find(id){ return docsOf(DATA || {}).find(d => d.id === id); }
function preview(id){ const d = find(id); window.ClientTabs.preview(id, d); }
function goClient(no){ const p = document.getElementById('dcPanel'); if(p) p.remove(); if(typeof window.openClient === 'function') window.openClient(no); }
async function retry(id){
  const d = find(id); if(!d) return;
  const el = document.querySelector('.dcdoc[data-id="' + id + '"] .s'); if(el) el.insertAdjacentHTML('beforeend', ' <span class="dim" id="dcRetry">· sending…</span>');
  const r = await window.ClientTabs.carrierPost({ action: 'retry_hawksoft', attachment_id: id });
  const m = document.getElementById('dcRetry'); if(m) m.remove();
  if(r && r.ok){ const row = (DATA.documents || []).find(x => x.id === id); if(row) row.filed_hawksoft = true; rerender(); }
  else alert((r && (r.message || r.hawksoft_why || r.error)) || 'HawkSoft did not take it.');
}
async function relabel(id){
  const d = find(id); if(!d) return;
  /* the client tabs' picker, on a one-document pseudo-card */
  const CT = window.ClientTabs; const card = cardFor(d);
  CT.html(card, { clientNo: d.client_no, actions: true, rerender: () => { const row = (DATA.documents || []).find(x => x.id === id); const nd = card.documents[0]; if(row){ row.doc_type = nd.doc_type; row.kind = nd.kind; row.doc_label = nd.doc_label; } rerender(); } });
  CT.relabel(id);
}
function csv(list){
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = ['date,time,client_no,client,type,file,size_bytes,uploaded_by,hawksoft,needs_label'];
  for(const d of list) lines.push([t(d.created_at, { year: 'numeric', month: '2-digit', day: '2-digit' }), t(d.created_at, { hour: 'numeric', minute: '2-digit' }), d.client_no, d.client_name, window.ClientTabs.typeLabel(d), d.filename || '', d.bytes || '', d.uploaded_by || '', d.filed_hawksoft ? 'yes' : 'no', d.needs ? 'yes' : 'no'].map(q).join(','));
  return lines.join('\r\n');
}
function download(){
  if(!DATA) return;
  const list = filtered(docsOf(DATA));
  const blob = new Blob(['﻿' + csv(list)], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'documents_' + range().from + '_' + range().to + '.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- loading: the Console tab, the portal panel ---------- */
let MODE = null;   // { kind: 'console', el } | { kind: 'portal' }
async function load(){
  if(!MODE) return;
  const r = range();
  const target = MODE.kind === 'console' ? MODE.el : document.getElementById('dcBody');
  if(!target) return;
  target.innerHTML = '<div class="dim" style="padding:12px">Loading the documents…</div>';
  const d = await window.api('documents&from=' + r.from + '&to=' + r.to + '&queues=1' + (F.who !== 'all' ? '&who=' + encodeURIComponent(F.who) : ''));
  if(!d || !d.ok){ target.innerHTML = '<div class="dim" style="padding:12px">' + esc((d && d.error) || 'The documents could not be loaded.') + '</div>'; return; }
  DATA = d;
  RERENDER = () => { const tg = MODE.kind === 'console' ? MODE.el : document.getElementById('dcBody'); if(tg) tg.innerHTML = html(DATA, { actions: true, mine: !d.is_admin }); };
  RERENDER();
  const sub = document.getElementById('dcSub'); if(sub) sub.textContent = ((d.agent_names || {})[d.me] || d.me) + ' · ' + fmtRange(r);
}
async function consoleLoad(el){ MODE = { kind: 'console', el }; await load(); }
async function open(){
  const old = document.getElementById('dcPanel'); if(old) old.remove();
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'dcPanel';
  box.innerHTML = '<div class="ctpanel act"><div class="hd"><div><b>My documents</b><div class="sub" id="dcSub"></div></div><span class="x" onclick="document.getElementById(\'dcPanel\').remove()">&#10005;</span></div><div class="abody" id="dcBody"></div></div>';
  box.onclick = e => { if(e.target === box) box.remove(); };
  document.body.appendChild(box);
  MODE = { kind: 'portal' }; await load();
}

window.DocCenter = { html, docsOf, filtered, matches, rangeFor, range, csv, consoleLoad, open, load, search, type, only, who, branch, more, preset, applyDates, preview, goClient, retry, relabel, download, fillThumbs, F, GROUPS };
})();
