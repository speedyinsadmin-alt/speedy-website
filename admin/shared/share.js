/* SHARE THIS COMMISSION (Sep 16) — the sheet behind "share with…" on the payment card.
   Saif: Sammy could not share client 26424 with Jorge because the old flow only knew a
   helper it could see on the record (whoever ran the charge or the audit), asked once at
   audit time, and never let anyone pick a person. This one does: the commission owner
   (or an admin) names anyone on the roster, says how much of THEIR commission, and why;
   before or after the audit; locked once set, Tony can change it. Three steps, the same
   shape as the refund sheet. Posts set_share {payment_id, helper, pct, why}. Loaded by
   both pages after paycard.js; uses the ctlight/ctpanel styles from clienttabs.css. */
(function(){
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const money = n => { const v = Number(n||0); return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
function t(ts, o){ try { return new Date(ts).toLocaleString('en-US', Object.assign({ timeZone: 'America/Los_Angeles' }, o)); } catch(e){ return String(ts || '').slice(0, 16); } }
let S = null;   // { p, c, no, helper, pct, custom, why, admin }
const PCTS = [25, 50, 75];
/* the agent's own commission on this payment: their rate x Speedy's fee (fee unknown before the audit: say so) */
function myCommission(){ const fee = Number(S.p.fee_amount); const rate = Number(S.c.my_rate || 0); if(!Number.isFinite(fee) || !rate) return null; return +(fee * rate / 100).toFixed(2); }
function open(paymentId, clientNo){
  const c = (window.CLIENT_CACHE && window.CLIENT_CACHE[clientNo]) || (window.__shareCard) || null;
  const p = c && (c.payments || []).find(x => x.id === paymentId);
  if(!p){ alert('That payment is not on the card.'); return; }
  /* the portal declares `let EMAIL` - a lexical global, not window.EMAIL (the TOKEN lesson, Sep 16) */
  let pageMail = ''; try{ if(typeof EMAIL !== 'undefined' && EMAIL) pageMail = EMAIL; }catch(e){}
  const me = String(pageMail || window.EMAIL || window.__shareMe || '').toLowerCase();
  const admin = !!(c && c.is_admin);
  const owner = String(p.commission_to || p.charged_by_email || '').toLowerCase();
  if(!admin && owner !== me){ alert('Only ' + (p.commission_to_name || 'the agent who earns it') + ' can share this commission.'); return; }
  if(!admin && p.share){ alert('This split is already set. Ask the owner if it needs changing.'); return; }
  S = { p, c, no: clientNo, helper: p.share && p.share.helper ? p.share.helper : null, pct: p.share ? Number(p.share.pct || 0) || 50 : 50, custom: false, why: p.share && p.share.why || '', admin, owner, me };
  render();
}
function people(){
  const names = (S.c.agent_names) || {};
  const list = Object.entries(names).map(([e, n]) => ({ email: e, name: n })).filter(x => x.email !== S.owner && /@speedyins\.com$/.test(x.email));
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return list;
}
function render(){
  const old = document.getElementById('shareWith'); if(old) old.remove();
  const p = S.p; const mine = myCommission();
  const ownerName = p.commission_to_name || S.owner;
  const iOwn = S.owner === S.me;
  const box = document.createElement('div'); box.className = 'ctlight'; box.id = 'shareWith';
  const amt = pct => mine != null ? money(mine * pct / 100) : '';
  const helperName = S.helper ? ((S.c.agent_names || {})[S.helper] || S.helper) : null;
  const ready = !!S.helper && S.pct > 0 && S.pct <= 100 && String(S.why || '').trim().length >= 3;
  box.innerHTML = '<div class="ctpanel small share"><div class="hd"><div><b>' + (p.share ? 'Change this share' : 'Share this commission') + '</b>'
    + '<div class="sub">' + money(p.amount) + ' · ' + esc(p.purpose || '') + ' · client #' + esc(S.no) + ' · ' + (iOwn ? 'your' : esc(ownerName) + '’s') + ' commission' + (p.audit_status === 'complete' ? '' : ' when approved') + ': '
    + (mine != null ? '<b class="green">' + money(mine) + '</b> <span class="dim">' + (Number(S.c.my_rate || 0) >= 100 ? '(the fee Speedy kept on it)' : '(' + Number(S.c.my_rate || 0) + '% of the ' + money(p.fee_amount) + ' fee)') + '</span>' : '<span class="dim">known after the audit — the share is a percentage of it either way</span>') + '</div></div>'
    + '<span class="x" onclick="ShareWith.close()">&#10005;</span></div>'
    + '<div class="sstep"><div class="q">1 · With whom?</div><div class="speople">' + people().map(x => '<span class="sp' + (S.helper === x.email ? ' on' : '') + '" onclick="ShareWith.pick(\'' + esc(x.email) + '\')">' + esc(x.name) + '</span>').join('') + '</div></div>'
    + '<div class="sstep"><div class="q">2 · How much of ' + (iOwn ? '<u>your</u>' : esc(ownerName.split(' ')[0]) + '’s') + ' commission?</div><div class="spcts">'
    + PCTS.map(n => '<div class="spct' + (!S.custom && S.pct === n ? ' on' : '') + '" onclick="ShareWith.pct(' + n + ')"><b>' + n + '%</b><span>' + (amt(n) || '&nbsp;') + '</span></div>').join('')
    + '<div class="spct' + (S.custom ? ' on' : '') + '" onclick="ShareWith.custom()"><b>' + (S.custom ? esc(String(S.pct)) + '%' : '…%') + '</b><span>' + (S.custom ? (amt(S.pct) || 'another') : 'another') + '</span></div></div>'
    + (S.custom ? '<input class="ctin" id="shPct" type="number" min="1" max="100" step="1" value="' + esc(String(S.pct)) + '" oninput="ShareWith.setPct(this.value)" style="margin-top:8px;width:120px">' : '') + '</div>'
    + '<div class="sstep"><div class="q">3 · Why? <span class="dim" style="font-weight:400;font-size:13px">— one line, it goes on the client’s log</span></div>'
    + '<input class="ctin" id="shWhy" maxlength="200" placeholder="e.g. Jorge brought the referral in and did the quote" value="' + esc(S.why || '') + '" oninput="ShareWith.setWhy(this.value)"></div>'
    + '<div class="ssum">' + (S.helper && S.pct > 0
        ? (iOwn ? 'You keep' : esc(ownerName.split(' ')[0]) + ' keeps') + ' <b class="green">' + (mine != null ? money(mine * (100 - S.pct) / 100) : (100 - S.pct) + '%') + '</b> · ' + esc(helperName) + ' receives <b class="green">' + (mine != null ? money(mine * S.pct / 100) : S.pct + '%') + '</b>'
          + (mine != null ? ' <span class="dim">· of ' + (iOwn ? 'your ' : '') + money(mine) + '</span>' : '') + '<br><span class="dim">Paid when the audit is approved, on the month it is approved. ' + (S.admin ? 'You can change it again.' : 'Locked once you confirm; Tony can change it from the Console.') + '</span>'
        : '<span class="dim">Pick a person and an amount.</span>') + '</div>'
    + '<div class="sbtn' + (ready ? '' : ' off') + '" onclick="ShareWith.submit()">' + (S.helper && S.pct > 0 ? 'Share ' + esc(String(S.pct)) + '% with ' + esc(helperName) : 'Share') + '</div>'
    + (S.admin && p.share ? '<div class="scancel" onclick="ShareWith.remove()">Remove the share — ' + esc(ownerName.split(' ')[0]) + ' keeps all of it</div>' : '')
    + '<div class="scancel" onclick="ShareWith.close()">Cancel</div><div class="msg" id="shMsg"></div></div>';
  box.onclick = e => { if(e.target === box) close(); };
  document.body.appendChild(box);
}
function close(){ const b = document.getElementById('shareWith'); if(b) b.remove(); S = null; }
function pick(email){ if(!S) return; S.helper = email; render(); }
function pct(n){ if(!S) return; S.pct = n; S.custom = false; render(); }
function custom(){ if(!S) return; S.custom = true; if(PCTS.includes(S.pct)) S.pct = 40; render(); setTimeout(() => { const i = document.getElementById('shPct'); if(i){ i.focus(); i.select(); } }, 0); }
function setPct(v){ if(!S) return; const n = Math.round(Number(v)); S.pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; const s = document.querySelector('#shareWith .ssum'); if(s) { /* keep typing: only the summary and button move */ const btn = document.querySelector('#shareWith .sbtn'); const mine = myCommission(); const helperName = (S.c.agent_names || {})[S.helper] || S.helper; if(S.helper && S.pct > 0){ s.innerHTML = 'Keeps <b class="green">' + (mine != null ? money(mine * (100 - S.pct) / 100) : (100 - S.pct) + '%') + '</b> · ' + esc(helperName) + ' receives <b class="green">' + (mine != null ? money(mine * S.pct / 100) : S.pct + '%') + '</b>'; btn.textContent = 'Share ' + S.pct + '% with ' + helperName; btn.classList.toggle('off', !(String(S.why || '').trim().length >= 3)); } else { btn.classList.add('off'); } } }
function setWhy(v){ if(!S) return; S.why = String(v || ''); const btn = document.querySelector('#shareWith .sbtn'); if(btn) btn.classList.toggle('off', !(S.helper && S.pct > 0 && S.why.trim().length >= 3)); }
async function submit(){
  if(!S) return;
  const msg = document.getElementById('shMsg');
  if(!S.helper){ msg.textContent = 'Pick who receives the share.'; return; }
  if(!(S.pct > 0 && S.pct <= 100)){ msg.textContent = 'Pick how much.'; return; }
  if(String(S.why || '').trim().length < 3){ msg.textContent = 'Say why, in a few words.'; return; }
  const helperName = (S.c.agent_names || {})[S.helper] || S.helper;
  const mine = myCommission();
  if(!confirm(helperName + ' will receive ' + (mine != null ? money(mine * S.pct / 100) + ' (' + S.pct + '%)' : S.pct + '%') + ' of the commission on this ' + money(S.p.amount) + ' payment.\n\n' + (S.admin ? 'Continue?' : 'This is locked once set. Continue?'))) return;
  msg.textContent = 'Saving…';
  const post = window.apiPostBody || window.apiPost;
  const r = await post({ action: 'set_share', payment_id: S.p.id, helper: S.helper, pct: S.pct, why: String(S.why || '').trim(), source: window.apiPostBody ? 'console' : 'portal' });
  if(!r || !r.ok){ msg.textContent = (r && r.error) || 'Could not save it.'; return; }
  S.p.share = { helper: S.helper, helper_name: helperName, pct: S.pct, set_by: S.me, set_by_name: (S.c.agent_names || {})[S.me] || S.me, at: new Date().toISOString(), why: String(S.why || '').trim() };
  const no = S.no; close();
  if(typeof window.refreshClientCard === 'function') window.refreshClientCard(no);
  else if(typeof window.renderPanel === 'function') window.renderPanel();
}
async function remove(){
  if(!S || !S.admin) return;
  if(!confirm('Remove the share? ' + (S.p.commission_to_name || 'The owner') + ' keeps all of the commission.')) return;
  const post = window.apiPostBody || window.apiPost;
  const r = await post({ action: 'set_share', payment_id: S.p.id, pct: 0, source: window.apiPostBody ? 'console' : 'portal' });
  const msg = document.getElementById('shMsg');
  if(!r || !r.ok){ if(msg) msg.textContent = (r && r.error) || 'Could not save it.'; return; }
  S.p.share = { helper: null, helper_name: null, pct: 0, set_by: S.me, at: new Date().toISOString(), why: null };
  const no = S.no; close();
  if(typeof window.refreshClientCard === 'function') window.refreshClientCard(no);
  else if(typeof window.renderPanel === 'function') window.renderPanel();
}
window.ShareWith = { open, close, pick, pct, custom, setPct, setWhy, submit, remove, people: () => S ? people() : [], state: () => S };
window.openShareWith = open;
})();
