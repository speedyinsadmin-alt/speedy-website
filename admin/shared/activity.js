/* THE ACTIVITY REPORT (Sep 16) — the client Log sliced by PERSON.
   "My activity" on the portal: what one agent did, today / this week / this month / a
   range, with the tiles Saif asked for and the same sentences the client Log uses.
   "Activity" on the Console: everyone, one row per agent, then the stream. Both read
   the `activity` view, which returns rows grouped by client in the shapes the client
   tabs already understand, so ClientTabs.logEntries writes every sentence and nothing
   here re-invents wording. Loaded after clienttabs.js on both pages. */
(function(){
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const money = n => { const v = Number(n||0); return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
function t(ts, o){ try { return new Date(ts).toLocaleString('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, o)); } catch(e){ return String(ts || '').slice(0, 16); } }
const dayKey = ts => t(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = ts => t(ts, { weekday: 'long', month: 'short', day: 'numeric' });
const timeOnly = ts => t(ts, { hour: 'numeric', minute: '2-digit' });
const whenShort = ts => t(ts, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
/* today in Pacific as YYYY-MM-DD, and the range presets */
function todayPT(){ return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); }
function shift(d, n){ const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function rangeFor(preset){
  const to = todayPT();
  if(preset === 'today') return { from: to, to };
  if(preset === 'month') return { from: to.slice(0, 8) + '01', to };
  /* this week: Monday to today */
  const dow = new Date(to + 'T12:00:00Z').getUTCDay(); const back = (dow + 6) % 7;
  return { from: shift(to, -back), to };
}
const RANGE = { preset: 'week', from: null, to: null };
function current(){ if(RANGE.preset === 'custom' && RANGE.from && RANGE.to) return { from: RANGE.from, to: RANGE.to }; return rangeFor(RANGE.preset); }

/* ---------- entries: every client's log, flattened, tagged with the client ---------- */
function entries(data){
  const out = [];
  for(const c of (data.clients || [])){
    const card = { client: { client_no: c.client_no }, payments: c.payments || [], documents: c.documents || [], events: c.events || [], policies: [], agent_names: data.agent_names || {} };
    const list = window.ClientTabs.logEntries(card);
    const push = e => { out.push(Object.assign({}, e, { client_no: c.client_no, client_name: c.name || ('Client #' + c.client_no), card })); (e.replies || []).forEach(push); };
    list.forEach(push);
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return out;
}
/* what counts as MINE: what I did, plus the send-backs addressed to me */
const mine = (list, me) => list.filter(e => (e.who && e.who === me) || (e.k === 'sent_back' && e.to === me));
function tiles(list, me){
  const my = me ? mine(list, me) : list;
  const n = k => my.filter(e => e.k === k).length;
  return { charged: my.filter(e => e.k === 'charge').reduce((a, e) => a + Number(e.amount || 0), 0), payments: n('charge'), docs: n('upload'),
    submitted: n('submit'), sent_back: my.filter(e => e.k === 'sent_back' && (!me || e.to === me)).length, refunds: n('refund_ask'), notes: n('note'), not_told: n('not_told') };
}
const strip = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&#10003;/g, '✓').replace(/&#8627;/g, '↳').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/* ---------- rows ---------- */
function rowsHtml(list, opts){
  if(!list.length) return '<div class="dnone">Nothing in this range.</div>';
  let h = '', day = null;
  for(const e of list){
    const dk = dayKey(e.ts);
    if(dk !== day){ day = dk; h += '<div class="lday">' + esc(dayLabel(e.ts)) + '</div>'; }
    const client = '<a class="dlink" onclick="' + (opts.openClient || 'openClient') + '(' + Number(e.client_no) + ')">' + esc(e.client_name) + '</a>';
    const who = opts.everyone && e.who ? '<span class="who">' + esc(String(window.ClientTabs.nameOf(e.who, e.card)).split(' ')[0]) + '</span> ' : '';
    h += '<div class="lrow"><div class="when">' + esc(timeOnly(e.ts)) + '</div><div class="dot ' + (e.red ? 'red' : 'd-' + e.cat) + '"></div><div class="w">' + who + client + ' · ' + e.text + (e.meta ? '<span class="m">' + e.meta + '</span>' : '') + '</div></div>';
  }
  return h;
}
function chipsHtml(fn){
  const P = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['custom', 'Pick dates…']];
  const r = current();
  return '<div class="lfil arange">' + P.map(([k, l]) => '<span class="' + (RANGE.preset === k ? 'on' : '') + '" onclick="' + fn + '(\'' + k + '\')">' + l + '</span>').join('')
    + '<span class="dates">' + esc(fmtRange(r)) + '</span></div>'
    + (RANGE.preset === 'custom' ? '<div class="adates"><input type="date" id="actFrom" value="' + esc(RANGE.from || r.from) + '"> <span class="dim">to</span> <input type="date" id="actTo" value="' + esc(RANGE.to || r.to) + '"> <span class="noteok" onclick="Activity.applyDates()">Show</span></div>' : '');
}
function fmtRange(r){ const f = t(r.from + 'T12:00:00Z', { month: 'short', day: 'numeric' }), g = t(r.to + 'T12:00:00Z', { month: 'short', day: 'numeric' }); return f === g ? f : f + ' – ' + g; }

/* ---------- the portal: My activity ---------- */
let DATA = null, ME = null;
function tilesHtml(tl, tot){
  const tile = (v, l, warn) => '<div class="atile' + (warn && v ? ' warn' : '') + '"><b>' + v + '</b><span>' + l + '</span></div>';
  return '<div class="atiles">' + tile(money(tl.charged), 'charged · ' + tl.payments + ' payment' + (tl.payments === 1 ? '' : 's')) + tile(tl.docs, 'documents uploaded') + tile(tl.submitted, 'submitted for review')
    + tile(tl.sent_back, 'sent back to fix', true) + tile(tl.refunds, 'refund' + (tl.refunds === 1 ? '' : 's') + ' asked') + tile(tl.notes, 'note' + (tl.notes === 1 ? '' : 's') + ' written') + '</div>';
}
function myHtml(data, me){
  const all = entries(data); const my = mine(all, me);
  const tl = tiles(all, me);
  const name = (data.agent_names || {})[me] || me;
  return '<div class="ctlog act">' + chipsHtml('Activity.preset') + tilesHtml(tl)
    + rowsHtml(my, { openClient: 'Activity.goClient' })
    + '<div class="afoot"><div onclick="Activity.print()">&#128424; Print</div><div onclick="Activity.download()">&#11015; Download (CSV)</div></div>'
    + '<div class="lnote">Only what you did on the platform, ' + esc(name) + '. Commission figures are on the Commission page, not here.</div></div>';
}
async function open(){
  const old = document.getElementById('actPanel'); if(old) old.remove();
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'actPanel';
  box.innerHTML = '<div class="ctpanel act"><div class="hd"><div><b>My activity</b><div class="sub" id="actSub"></div></div><span class="x" onclick="document.getElementById(\'actPanel\').remove()">&#10005;</span></div><div class="abody" id="actBody"><div class="dim" style="padding:24px">Loading…</div></div></div>';
  box.onclick = e => { if(e.target === box) box.remove(); };
  document.body.appendChild(box);
  await load();
}
async function load(){
  const body = document.getElementById('actBody'); if(!body) return;
  const r = current();
  const d = await window.api('activity&from=' + r.from + '&to=' + r.to);
  if(!d || !d.ok){ body.innerHTML = '<div class="dim" style="padding:24px">' + esc((d && d.error) || 'The report could not be loaded.') + '</div>'; return; }
  DATA = d; ME = d.me;
  const sub = document.getElementById('actSub'); if(sub) sub.textContent = ((d.agent_names || {})[d.me] || d.me) + ' · ' + fmtRange(r);
  body.innerHTML = myHtml(d, d.me);
}
function preset(k){ RANGE.preset = k; if(k !== 'custom'){ RANGE.from = RANGE.to = null; } const body = document.getElementById('actBody'); if(body && k === 'custom'){ body.innerHTML = '<div class="ctlog act">' + chipsHtml('Activity.preset') + '</div>'; return; } if(document.getElementById('actBody')) load(); else if(typeof window.renderActivity === 'function') window.renderActivity(); }
function applyDates(){ const f = document.getElementById('actFrom'), g = document.getElementById('actTo'); if(!f || !g || !f.value || !g.value) return; RANGE.preset = 'custom'; RANGE.from = f.value; RANGE.to = g.value; if(document.getElementById('actBody')) load(); else if(typeof window.renderActivity === 'function') window.renderActivity(); }
function goClient(no){ const p = document.getElementById('actPanel'); if(p) p.remove(); if(typeof window.openClient === 'function') window.openClient(no); }
function print(){ window.print(); }
function csv(list, everyone){
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['date', 'time', 'who', 'client_no', 'client', 'what', 'details'];
  const lines = [head.join(',')];
  for(const e of list) lines.push([t(e.ts, { year: 'numeric', month: '2-digit', day: '2-digit' }), timeOnly(e.ts), e.who || '', e.client_no, e.client_name, strip(e.text), strip(e.meta)].map(q).join(','));
  return lines.join('\r\n');
}
function download(){
  if(!DATA) return;
  const all = entries(DATA); const list = DATA.is_admin && !DATA.agent && document.getElementById('actConsole') ? all : mine(all, ME);
  const blob = new Blob(['﻿' + csv(list)], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'activity_' + DATA.from + '_' + DATA.to + '.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- the Console: everyone, by agent ---------- */
const CF = { agent: 'all', branch: 'all' };
function consoleHtml(data){
  const all = entries(data);
  const roster = (data.roster || []).slice();
  const branches = [...new Set(roster.map(a => a.branch).filter(Boolean))].sort();
  const inBranch = a => CF.branch === 'all' || a.branch === CF.branch;
  const people = roster.filter(inBranch).filter(a => CF.agent === 'all' || a.email === CF.agent);
  const peopleEmails = new Set(people.map(a => a.email));
  const list = all.filter(e => (e.who && peopleEmails.has(e.who)) || (e.k === 'sent_back' && peopleEmails.has(e.to)) || (CF.agent === 'all' && CF.branch === 'all' && !e.who));
  const now = Date.now();
  const rows = people.map(a => {
    const tl = tiles(all, a.email);
    const last = all.filter(e => e.who === a.email).map(e => e.ts)[0] || data.last_seen[a.email] || null;
    const quiet = last ? Math.floor((now - new Date(last).getTime()) / 86400000) : null;
    return { a, tl, last, quiet };
  });
  const tot = rows.reduce((s, r) => { for(const k in r.tl) s[k] = (s[k] || 0) + r.tl[k]; return s; }, {});
  const td = (v, cls) => '<td class="' + (cls || '') + '">' + v + '</td>';
  let h = '<div class="ctlog act" id="actConsole">'
    + '<div class="abar"><select class="ctsel" onchange="Activity.setAgent(this.value)"><option value="all">All agents</option>' + roster.map(a => '<option value="' + esc(a.email) + '"' + (CF.agent === a.email ? ' selected' : '') + '>' + esc(a.full_name || a.email) + '</option>').join('') + '</select>'
    + '<select class="ctsel" onchange="Activity.setBranch(this.value)"><option value="all">All branches</option>' + branches.map(b => '<option' + (CF.branch === b ? ' selected' : '') + '>' + esc(b) + '</option>').join('') + '</select>'
    + chipsHtml('Activity.preset')
    + '<span class="abtn" onclick="Activity.download()">&#11015; Export CSV</span><span class="abtn" onclick="Activity.print()">&#128424; Print</span></div>'
    + '<div class="atable"><table><tr><th>Agent</th><th>Charged</th><th>Payments</th><th>Docs</th><th>Submitted</th><th>Sent back</th><th>Refunds asked</th><th>Notes</th><th>Not told</th><th>Last active</th></tr>'
    + rows.map(r => '<tr>' + td('<a class="dlink" onclick="Activity.setAgent(\'' + esc(r.a.email) + '\')">' + esc(r.a.full_name || r.a.email) + '</a>' + (r.a.branch ? ' <span class="dim">· ' + esc(r.a.branch) + '</span>' : ''))
        + td(money(r.tl.charged)) + td(r.tl.payments) + td(r.tl.docs) + td(r.tl.submitted) + td(r.tl.sent_back, r.tl.sent_back ? 'warn' : '') + td(r.tl.refunds) + td(r.tl.notes) + td(r.tl.not_told, r.tl.not_told ? 'red' : '')
        + td(r.last ? (r.quiet >= 7 ? '<span class="warn">' + esc(t(r.last, { month: 'short', day: 'numeric' })) + ' — quiet ' + r.quiet + ' days</span>' : esc(whenShort(r.last))) : '<span class="warn">never</span>') + '</tr>').join('')
    + '<tr class="tot">' + td('Everyone · ' + esc(fmtRange(current()))) + td(money(tot.charged || 0)) + td(tot.payments || 0) + td(tot.docs || 0) + td(tot.submitted || 0) + td(tot.sent_back || 0, tot.sent_back ? 'warn' : '') + td(tot.refunds || 0) + td(tot.notes || 0) + td(tot.not_told || 0, tot.not_told ? 'red' : '') + td('') + '</tr>'
    + '</table></div>'
    + '<div class="lday" style="margin-top:14px">' + (CF.agent === 'all' ? 'Everyone' : esc((data.agent_names || {})[CF.agent] || CF.agent)) + ' · ' + list.length + ' entries</div>'
    + rowsHtml(list, { openClient: 'openClient', everyone: true })
    + '<div class="lnote">"Not told" counts every charge or refund where the client got no email. "Sent back" is what the auditor returned to that agent. A quiet agent (7+ days with nothing on the platform) is shown, not hidden.</div></div>';
  return h;
}
async function consoleLoad(el){
  const r = current();
  el.innerHTML = '<div class="dim" style="padding:12px">Loading the activity…</div>';
  const d = await window.api('activity&from=' + r.from + '&to=' + r.to);
  if(!d || !d.ok){ el.innerHTML = '<div class="dim" style="padding:12px">' + esc((d && d.error) || 'The report could not be loaded.') + '</div>'; return; }
  DATA = d; ME = d.me;
  el.innerHTML = consoleHtml(d);
}
function setAgent(v){ CF.agent = v || 'all'; if(typeof window.renderActivity === 'function') window.renderActivity(); }
function setBranch(v){ CF.branch = v || 'all'; if(typeof window.renderActivity === 'function') window.renderActivity(); }

window.Activity = { entries, mine, tiles, myHtml, consoleHtml, consoleLoad, open, load, preset, applyDates, goClient, print, download, csv, setAgent, setBranch, rangeFor, current, RANGE, CF, strip };
})();
