/* ===================== THE CLIENT PANEL (Sep 17) =====================
   The portal's client card WITH its actions - policies, the Payments · Documents · Log
   tabs, charge, refund, add documents / finish the audit (carrier.html), link a balance,
   "client still owes more", reassign, wrong client, ↻ HawkSoft - in one file, so the
   Console can show Tony exactly the page the agent has, with every action, instead of
   its own read-only copy. Lifted verbatim out of portal.html: the functions keep their
   names, every onclick in the markup still resolves. Only the places that reached into
   the portal's OWN screens - its tab bar, its home tiles, its to-do sheet, its office
   picker, its same-tab jump to carrier.html - go through PanelHost below, which the
   portal leaves alone and the Console overrides.

   HOST CONTRACT (both pages load this as a plain script beside clientpanel.css):
     globals    TOKEN, EMAIL, ME, ROSTER, OFFICES - top-level `let` on the page (a
                lexical global this file reads; ME / ROSTER / OFFICES it also assigns)
     functions  api(view), esc(), money(), $(); apiPost(body) or apiPostBody(body)
     markup     <div id="clientPanel"> where the card renders; the charge and refund
                sheets are mounted on <body> by this file
     owns       ACTIVE_TAB, CLIENT_CACHE, POLICY_OPEN - declared HERE, not on the page
   A top-level let in one plain script is visible to the next (the TOKEN lesson,
   Sep 16); a name declared in two of them is a SyntaxError that blanks the page. */

/* ---- HOST HOOKS. The portal is the default; the Console overrides in platform.html. ---- */
const PanelHost = {
  page: 'portal',
  /* the open client's tab, for the carrier page's title: the portal's tab bar */
  tab: no => (typeof OPEN_TABS !== 'undefined' ? OPEN_TABS : []).find(t => t.client_no === no),
  /* the office a charge is stamped with: the one the agent picked at sign-in */
  office: () => (typeof OFFICE !== 'undefined' ? OFFICE : null),
  /* one POST helper on each page: the portal's apiPost takes the body, the Console's apiPostBody does */
  post: body => (window.apiPostBody || window.apiPost)(body),
  /* the client changed on the server (balance linked, total set, reassigned, moved):
     re-read it and let the page's own lists catch up (the portal's home tiles) */
  changed: async no => { if(no){ delete CLIENT_CACHE[no]; openClient(no); } await loadHome(); },
  /* a refund went through: re-read the client */
  reload: async no => { delete CLIENT_CACHE[no]; await openClient(no); },
  /* the charge sheet closed */
  closed: () => { loadHome(); },
  /* the to-do sheet, if it is open, reflects a reassignment or a move */
  todo: () => { const sheet = document.getElementById('todoSheet'); if(sheet && !sheet.classList.contains('hide')){ if(UNFINISHED.length) openTodo(); else closeTodo(); } },
  /* to the carrier page: the portal goes there in this tab and comes back */
  carrier: p => { location.href = panelCarrierHref(p); },
  carrierParams: p => p,
  carrierAttr: () => '',
  authExpired: () => { if(typeof onAuthExpired === 'function') onAuthExpired(); else if(typeof showAuthExpired === 'function') showAuthExpired(); },
};
function panelCarrierHref(p){ PanelHost.carrierParams(p); return '/admin/carrier.html?' + p.toString() + (TOKEN ? '#tok=' + encodeURIComponent(TOKEN) : ''); }
/* the HawkLink launch context (portal only): armed when the agent arrived from HawkSoft with a policy */
function panelHL(){ try{ if(typeof HL !== 'undefined' && HL) return HL; }catch(e){} return { armed:false, policy:'', client:null }; }

/* ---- the panel's state (the portal's search / tab bar read these too) ---- */
let ACTIVE_TAB = null;   // client_no
let CLIENT_CACHE = {};   // client_no -> detail (the portal_client view)
let POLICY_OPEN = {};    // client_no -> index of the one open policy, or null

/* ---- the two sheets. Mounted on <body> once, by whichever page loads this file. ---- */
const REFUND_SHEET_HTML = "<div id=\"refundSheet\" class=\"hide\"><div><div class=\"card\" id=\"rfBody\"></div></div></div>";
const CHARGE_SHEET_HTML = "<div id=\"chargeSheet\" class=\"hide\">\n  <div style=\"max-width:640px;margin:0 auto\">\n    <div class=\"card\" style=\"border-color:var(--blue)\">\n\n      <div class=\"row\" style=\"align-items:flex-start;margin-bottom:12px\">\n        <div>\n          <div style=\"font-size:16px;font-weight:800\" id=\"chgTitle\">Charge</div>\n          <div class=\"muted\" style=\"font-size:13px;margin-top:2px\" id=\"chgSub\">—</div>\n        </div>\n        <div onclick=\"closeCharge()\" style=\"cursor:pointer;color:var(--mute);font-size:20px;padding:0 4px\" title=\"Close\">&#10005;</div>\n      </div>\n\n      <div id=\"chgAuthWarn\" class=\"hide\" style=\"background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.4);border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:10px;color:var(--amber-ink)\">\n        Your sign-in expired. <span style=\"color:var(--blue-l);cursor:pointer;text-decoration:underline\" onclick=\"reauth()\">Sign in again</span> &mdash; nothing you typed is lost.\n      </div>\n\n      <div id=\"chgLoading\" class=\"dim\" style=\"font-size:13px\">Loading client from HawkSoft&hellip;</div>\n\n      <div id=\"chgBody\" class=\"hide\">\n        <div id=\"chgOpenBal\" class=\"hide\" style=\"background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.45);border-radius:10px;padding:11px 12px;margin-bottom:12px\"></div>\n        <div id=\"chgNamePick\"></div>\n        <div id=\"chgInv\"></div>\n        <!-- What HawkSoft will receive, under the picker, before the charge is made. -->\n        <div id=\"chgHsPreview\" class=\"hide\" style=\"border:1px solid var(--hair);border-radius:10px;padding:9px 12px;margin-bottom:12px\"></div>\n\n        <label for=\"chgAmt\">Amount</label>\n        <input id=\"chgAmt\" inputmode=\"decimal\" placeholder=\"0.00\" autocomplete=\"off\" oninput=\"showBalance();renderChgHsPreview()\">\n\n        <label style=\"margin-top:12px\">Purpose</label>\n        <div id=\"chgPurp\" class=\"chips\"></div>\n        <div id=\"chgPurpSub\" class=\"hide\" style=\"margin-top:8px;padding:10px 11px;background:var(--field);border:1px solid var(--line);border-radius:10px\"></div>\n        <div id=\"chgOtherWrap\" class=\"hide\">\n          <label for=\"chgOther\" style=\"margin-top:10px\">What's this payment for?</label>\n          <input id=\"chgOther\" placeholder=\"e.g. broker fee, notary, late fee only\" maxlength=\"60\" autocomplete=\"off\" oninput=\"syncPurposeGate();renderChgHsPreview()\">\n        </div>\n\n        <div style=\"margin-top:12px\">\n          <!-- PAID IN FULL, OR PART? (Saif, Sep 13: \"Total owed needs to be more recognised\".)\n               A grey optional field was blank on every full payment and so invisible on the\n               one that was not - and a part payment recorded as full derives the fee from the\n               part, which is the Sep 9 negative-fee bug. A question is read; a field is skipped.\n               \"Paid in full\" stays the default so a full payment costs nothing extra; the amount\n               box appears, red and required, only when the answer is Part payment. -->\n          <label>Is this the full amount the client owes for this sale?</label>\n          <div id=\"chgFull\" class=\"chips\">\n            <button type=\"button\" class=\"sel\" onclick=\"pickFull(true,this)\">Paid in full</button>\n            <button type=\"button\" class=\"part\" onclick=\"pickFull(false,this)\">Part payment &mdash; client still owes</button>\n          </div>\n          <div id=\"chgTotalWrap\" class=\"hide\" style=\"margin-top:8px;padding:10px 11px;background:rgba(224,49,49,.08);border:1px solid rgba(224,49,49,.45);border-radius:10px\">\n            <label for=\"chgTotal\" style=\"color:var(--red-ink)\">Total the client owes for this sale &mdash; required</label>\n            <input id=\"chgTotal\" inputmode=\"decimal\" placeholder=\"e.g. 187.00\" autocomplete=\"off\" oninput=\"showBalance();renderChgHsPreview()\" style=\"border-color:rgba(224,49,49,.55)\">\n          </div>\n          <div id=\"chgBal\" class=\"hide\" style=\"background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.35);border-radius:9px;padding:9px 10px;margin-top:6px;font-size:13px;color:var(--amber-ink)\"></div>\n        </div>\n\n        <label for=\"chgNote\" style=\"margin-top:12px\">Note &mdash; optional</label>\n        <input id=\"chgNote\" maxlength=\"120\" placeholder=\"Shows on the receipt\" autocomplete=\"off\">\n\n        <div id=\"chgPolWrap\" class=\"hide\" style=\"margin-top:12px\">\n          <label for=\"chgPolSel\">Apply to policy &mdash; files the receipt under that policy tab</label>\n          <select id=\"chgPolSel\" onchange=\"updatePolicyPreview()\"></select>\n          <div id=\"chgPolOdd\" class=\"hide\" style=\"background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.4);border-radius:9px;padding:9px 10px;margin-top:7px;font-size:13px;color:var(--amber-ink)\"></div>\n          <div id=\"chgPolPrev\" class=\"hide\" style=\"background:var(--card);border:1px solid var(--line);border-radius:9px;padding:9px 10px;margin-top:7px\">\n            <div class=\"dim\" style=\"font-size:12px\">Receipt will show</div>\n            <div id=\"chgPolPrevVal\" style=\"font-size:13px;margin-top:3px\"></div>\n          </div>\n        </div>\n\n        <div id=\"chgRefresh\" onclick=\"chgRefresh()\" style=\"border:1.5px solid var(--line);border-radius:9px;text-align:center;cursor:pointer;color:var(--mute);padding:9px;font-size:13px;margin-top:8px\">&#8635; New tab in HawkSoft? Refresh</div>\n\n        <div style=\"margin-top:12px\">\n          <label for=\"chgComm\">Commission to</label>\n          <select id=\"chgComm\" onchange=\"onCommChange()\"></select>\n          <div id=\"chgProdNote\" class=\"hide\" style=\"background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.35);border-radius:9px;padding:9px 10px;margin-top:6px\">\n            <div style=\"font-size:12px;color:var(--amber-ink)\" id=\"chgProdText\"></div>\n            <div class=\"dim\" style=\"font-size:12px;margin-top:2px\">Is this your job, or are you charging for someone?</div>\n            <div style=\"display:flex;gap:6px;margin-top:8px\">\n              <button type=\"button\" class=\"btn btn-ghost\" style=\"margin:0;padding:7px\" onclick=\"giveToProducer()\" id=\"chgGiveBtn\"></button>\n              <button type=\"button\" class=\"btn btn-ghost\" style=\"margin:0;padding:7px\" onclick=\"document.getElementById('chgComm').focus()\">Someone else…</button>\n            </div>\n          </div>\n        </div>\n\n        <label style=\"margin-top:12px\">Method</label>\n        <div id=\"chgMeth\" class=\"chips\"></div>\n\n        <div id=\"chgCard\" class=\"hide\" style=\"margin-top:10px\">\n          <div id=\"pCardNumber\" class=\"cf\"></div>\n          <div style=\"display:flex;gap:6px;margin-top:6px\">\n            <div id=\"pCardDate\" class=\"cf\" style=\"flex:1\"></div>\n            <div id=\"pCardCvv\" class=\"cf\" style=\"flex:1\"></div>\n            <div id=\"pCardZip\" class=\"cf\" style=\"flex:1\"></div>\n          </div>\n          <div class=\"dim\" id=\"chgCardHint\" style=\"font-size:12px;margin-top:6px\"></div>\n        </div>\n\n        <div id=\"chgAltWrap\" class=\"hide\" style=\"margin-top:10px\">\n          <label id=\"chgAltLabel\">Reference &mdash; optional</label>\n          <input id=\"chgAltRef\" autocomplete=\"off\" maxlength=\"60\">\n        </div>\n\n        <div id=\"chgGoWhy\" class=\"hide\"></div>\n        <button class=\"btn btn-red\" id=\"chgGo\" onclick=\"doCharge()\">Charge</button>\n        <button class=\"btn btn-ghost\" onclick=\"closeCharge()\">Cancel</button>\n        <div id=\"chgOut\" class=\"hide dim\" style=\"font-size:13px;margin-top:10px;text-align:center\"></div>\n      </div>\n\n      <div id=\"chgResult\"></div>\n    </div>\n  </div>\n</div>";
function panelMountSheets(){
  if(!document.getElementById('refundSheet')) document.body.insertAdjacentHTML('beforeend', REFUND_SHEET_HTML);
  if(!document.getElementById('chargeSheet')) document.body.insertAdjacentHTML('beforeend', CHARGE_SHEET_HTML);
}
if(document.body) panelMountSheets(); else document.addEventListener('DOMContentLoaded', panelMountSheets);

function chgSubHtml(no){
  /* Where the confirmation WILL go, said before the charge — or that it will go
     nowhere. 19 of the last 60 charges had no email on file and the agent found out
     never: the result was recorded on the row and shown on no screen. */
  const em = (CHG && CHG.confirmed && CHG.confirmed.emails && CHG.confirmed.emails[0]) || '';
  return '#' + esc(String(no)) + ' \u00b7 ' + esc(PanelHost.office())
    + (panelHL().armed ? ' \u00b7 <span style="color:var(--blue-l);cursor:pointer;text-decoration:underline" onclick="hlChangeOffice()">change office</span>' : '')
    + (em ? '<div style="font-size:12px;color:var(--mute);margin-top:3px">Confirmation will be emailed to <b style="color:var(--ink)">' + esc(em) + '</b></div>'
          : '<div style="font-size:12px;color:var(--red-ink);margin-top:3px;font-weight:600">&#9888; No email on this client’s record — they will get no confirmation. Add one in HawkSoft first if they should.</div>');
}
function hlChangeOffice(){
  var pick = prompt('Charging as ' + PanelHost.office() + '.\n\nType the office to charge under:\n\n' + OFFICES.join('\n'), PanelHost.office());
  if(!pick) return;
  var hit = OFFICES.find(function(o){ return o.toLowerCase() === pick.trim().toLowerCase(); });
  if(!hit){ alert('Not a branch: ' + pick); return; }
  if(typeof applyOffice === 'function') applyOffice(hit);
  if(CHG && CHG.clientNo) chgEl('chgSub').innerHTML = chgSubHtml(CHG.clientNo);
}

// --- client detail ---
async function loadClient(no){
  await renderPanel(); // shows loading
  const r = await api('portal_client&no=' + no);
  if(r && r.ok) CLIENT_CACHE[no] = r;
  renderPanel();
  if(r && r.ok) loadPortalThumbs(no);
}
function isExpired(p){
  if(!p.expiration_date) return false;
  return String(p.expiration_date).slice(0,10) < new Date().toISOString().slice(0,10);
}
function termMonths(p){
  if(!p.effective_date || !p.expiration_date) return null;
  const a = new Date(p.effective_date), b = new Date(p.expiration_date);
  const mo = Math.round((b - a) / (1000*60*60*24*30.44));
  return mo > 0 ? mo : null;
}
async function renderPanel(){
  const el = document.getElementById('clientPanel');
  if(!ACTIVE_TAB){ el.innerHTML=''; return; }
  const r = CLIENT_CACHE[ACTIVE_TAB];
  if(!r){ el.innerHTML = '<div class="card"><div class="dim">Loading client…</div></div>'; return; }
  const c = r.client;
  const name = c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' ');
  const pols = (r.policies || []).filter(p => p.record_type !== 'dmv_service');
  const dmv = (r.policies || []).filter(p => p.record_type === 'dmv_service');
  let h = '<div class="card" style="border-color:var(--blue)">';
  // header
  h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">'
    + '<div><div style="font-size:16px;font-weight:800">'+esc(name)+'</div>'
    + '<div class="muted" style="font-size:13px">#'+c.client_no+(c.branch?' · '+esc(c.branch):'')+(c.phone?' · <span style="color:var(--blue-l)">'+esc(c.phone)+'</span>':'')+'</div></div>'
    + '<span style="background:rgba(47,191,113,.2);color:var(--green);font-size:12px;padding:3px 9px;border-radius:6px;font-weight:700">'+esc(c.status||'Active')+'</span></div>';

  /* MONEY OWED BELONGS AT THE TOP OF THE CARD. It was only rendered inside a payment
     row, behind the "Payments & documents" toggle — so an agent had to know to expand a
     collapsed section to discover the client still owes money. Saif, Sep 10: it is
     important enough to show before the details are opened. It is a fact about the
     CLIENT, not about one payment, so it sits under the name with the policies.
     Same helper the charge sheet and the payment rows use. */
  const owedNow = openBalances(r);
  if(owedNow.length){
    const totalLeft = owedNow.reduce((a,b) => a + b.left, 0);
    h += '<div style="background:rgba(245,166,35,.10);border:1px solid rgba(245,166,35,.45);'
      + 'border-radius:9px;padding:9px 11px;margin-bottom:12px">'
      + '<div style="font-size:13px;font-weight:700;color:var(--amber-ink)">Owes $'
      + totalLeft.toFixed(2) + '</div>'
      + owedNow.map(b => '<div class="dim" style="font-size:12px;margin-top:2px">$'
          + b.got.toFixed(2) + ' of $' + b.owed.toFixed(2) + ' collected · from '
          + esc(String(b.ts).slice(0,10)) + '</div>').join('')
      + '</div>';
  }

  // policies compact
  h += '<div style="font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Policies ('+pols.length+')</div>';
  if(!pols.length) h += '<div class="dim" style="font-size:13px;margin-bottom:8px">No insurance policies</div>';
  /* One row per policy, each tappable. Client 6402 has FOURTEEN tabs: the old
     "See full details" expanded every one of them at once - drivers, vehicles,
     VINs, billing - so an agent scrolled past thirteen to reach the one he wanted,
     and the card built all fourteen on every render. Now it builds one.
     DMV records are rows too. They used to be a dead "+ 1 DMV service record" line
     that could not be opened, which is exactly the record a DMV charge needs. */
  const openIdx = POLICY_OPEN[ACTIVE_TAB];
  const allPols = pols.concat(dmv);
  for(let i = 0; i < allPols.length; i++){
    const p = allPols[i];
    const isDmv = p.record_type === 'dmv_service';
    const prem = Number(p.premium) || null;
    const tm = termMonths(p);
    const expired = isExpired(p);
    const open = openIdx === i;
    const premLabel = prem ? '$'+prem.toLocaleString()+(tm?' <span style="font-size:12px;color:var(--mute)">/ '+tm+'-mo term</span>':' <span style="font-size:12px;color:var(--mute)">term</span>') : '';
    const tabN = (function(){ const x = p.carrier_extras && p.carrier_extras.policyIndex;
                              return (x === 0 || x > 0) ? 'Tab '+(Number(x)+1) : ''; })();
    /* Enough on the collapsed row to pick the right policy without opening it:
       tab number, line of business, policy number. */
    const sub = [tabN, isDmv ? 'DMV' : (p.lob || ''), p.policy_number || ''].filter(Boolean).join(' · ');
    h += '<div style="background:var(--field);border:1px solid '+(open?'var(--blue)':'transparent')+';border-radius:10px;padding:11px 13px;margin-bottom:6px;cursor:pointer" onclick="togglePolicy('+i+')">'
      + '<div style="display:flex;justify-content:space-between;align-items:center">'
      + '<div style="min-width:0"><b style="font-size:13px">'+esc(p.carrier || (isDmv ? 'DMV service' : '—'))+'</b>'
      + '<div style="font-size:12px;color:'+(expired?'#ff8787':'var(--mute)')+'">'+esc(sub)
      + (expired ? ' · expired '+String(p.expiration_date).slice(0,10) : '')+'</div></div>'
      + '<div style="text-align:right;white-space:nowrap;padding-left:8px">'
      + (prem?'<div style="font-size:14px;font-weight:800;color:var(--blue-l)">'+premLabel+'</div>':'')
      + (!expired && p.status ? '<span style="font-size:12px;color:var(--amber-ink)">'+esc(p.status)+'</span>' : '')
      + ' <span style="color:'+(open?'var(--blue-l)':'var(--dim)')+';font-size:13px">'+(open?'&#9662;':'&#9656;')+'</span>'
      + '</div></div>'
      + (open ? policyDetailHtml(p) : '')
      + '</div>';
  }

  /* THE TABS (Sep 16): Payments · Documents · Log, in the slot "Recent activity" had.
     That three-line list was a baby log; the Log tab is what it grew into. The old
     bottom toggle hid the payment card - it is the default tab now. Shared renderer,
     /admin/shared/clienttabs.js, same as the Console. */
  h += ClientTabs.html(r, { me: EMAIL, clientNo: ACTIVE_TAB, actions: true, page: PanelHost.page,
    payHtml: payHistoryHtml(r), rerender: () => renderPanel() });

  // actions
  h += '<div style="display:grid;grid-template-columns:1fr;gap:8px;margin-top:14px">'
    + '<div onclick="openCharge('+ACTIVE_TAB+')" style="background:var(--red);color:#fff;border-radius:9px;padding:11px;text-align:center;font-size:13px;font-weight:700;cursor:pointer">Charge this client</div>'
    + '</div>'
    + '<div id="cardRefresh" onclick="refreshHawkSoft(\'cardRefresh\','+ACTIVE_TAB+',\'card\')" '
    + 'style="' + RF_BASE + ';padding:10px;font-size:13px;margin-top:8px">' + label('card') + '</div>';
  h += '</div>';
  el.innerHTML = h;
}
/* ---------- Payment history + documents on the client card ----------
   PERFORMANCE: this renders METADATA only — date, amount, filename, size. No file
   bytes and no thumbnails travel with the client load. Thumbnails arrive in a second
   small call once the card is on screen; a document's bytes are fetched only when the
   agent taps it. */
/* One renderer for "was the client told", for charges and refunds alike. */

// Thumbnails: a second small call, after the card is already visible.
async function loadPortalThumbs(no){
  try{
    const r = await api('portal_thumbs&no=' + encodeURIComponent(no));
    if(!r || !r.ok || !r.thumbs || !r.thumbs.length) return;
    r.thumbs.forEach(t => {
      const chip = document.getElementById('pd' + t.id);
      if(!chip || chip.dataset.thumbed) return;
      chip.dataset.thumbed = '1';
      chip.style.padding = '0';
      chip.style.overflow = 'hidden';
      const img = document.createElement('img');
      img.src = t.thumb_b64; img.alt = '';
      img.style.cssText = 'width:64px;height:48px;object-fit:cover;display:block';
      chip.textContent = '';
      chip.appendChild(img);
    });
  }catch(e){}
}

// A document's bytes are fetched here and nowhere else.

/* First name of whoever uploaded a document. The chip is small and the full email
   would push the size off the row, so: alejandra@speedyins.com -> Alejandra. */

/* The way back into an already-audited payment. Same page the agent knows, opened
   with docs=1 so it shows ONLY the document uploader — no carrier cost, no fee, no
   submit-to-audit. Append-only by construction. */
function addDocsFor(paymentId, clientNo, amount){
  stashHandoff();
  const tab = PanelHost.tab(clientNo);
  const cached = CLIENT_CACHE[clientNo] || {};
  const pay = ((cached.payments) || []).find(r => r.id === paymentId) || {};
  const p = new URLSearchParams({
    client: clientNo || '', name: (tab && tab.name) || '', paid: Number(amount||0).toFixed(2),
    method: 'client paid', payment_id: paymentId,
    policy: pay.policy_number || '', policy_guid: pay.policy_guid || '',
    docs: '1',
  });
  PanelHost.carrier(p);
}

/* ONE LINE FOR THE REVIEW STATE, on every payment row that can carry an audit.
   Sent back: red, the approver's reason verbatim - it is the instruction. Waiting:
   who submitted and that nothing is earned yet. Approved: who, when - "audited" alone
   used to mean the agent pressed the button themselves. Older rows approved before
   Sep 12 have no submitter and were completed by the agent; say nothing extra. */

/* THE PAYMENT CARD lives in /admin/shared/paycard.js (Sep 13) - one renderer for this
   page and the Console. These names stay so nothing else here changes. */
function payHistoryHtml(c){ return PayCard.html(c, { me: EMAIL, clientNo: ACTIVE_TAB, actions: true }); }
function noticeLineHtml(n){ return PayCard.noticeLineHtml(n); }
function auditLineHtml(p){ return PayCard.auditLineHtml(p); }
function sendbackLabel(code){ return PayCard.sendbackLabel(code); }
function docType(d){ return PayCard.docType(d); }
function docTypeLabel(k){ return PayCard.docTypeLabel(k); }
function bytesLabel(b){ return PayCard.bytesLabel(b); }
function uploaderShort(e){ return PayCard.uploaderShort(e); }
function refundable(p){ return PayCard.refundable(p); }
function canRefundRow(c, p){ return PayCard.canRefundRow(c, p); }
function openBalances(cache){ return PayCard.openBalances(cache); }

function finishAuditFor(paymentId, clientNo, amount){
  stashHandoff();
  const tab = PanelHost.tab(clientNo);
  const cached = CLIENT_CACHE[clientNo] || {};
  const pay = ((cached.payments) || []).find(r => r.id === paymentId) || {};
  const p = new URLSearchParams({
    client: clientNo || '', name: (tab && tab.name) || '', paid: Number(amount||0).toFixed(2),
    method: 'client paid', payment_id: paymentId,
    policy: pay.policy_number || '', policy_guid: pay.policy_guid || '',
    from: 'card',
  });
  PanelHost.carrier(p);
}


/* Earnings visibility. Remembered per browser so it stays hidden once chosen —
   an agent who hides it should not have it reappear next morning. */
/* ================= REFUNDS · stages 1-3 =================
   Full refunds only. Partial is stage 4 and is blocked on the ZZTEST probe: Clover's own
   documentation contradicts itself on whether /v1/refunds takes an `amount`, and a
   partial that Clover silently treats as FULL hands the client more than intended. The
   server refuses one; this screen does not offer one.

   The sheet asks four things and shows the consequence of each BEFORE the button, because
   the consequences are not guessable: which month the commission moves in, whether the
   client still owes the money, whether Speedy has lost the carrier's share, and that
   HawkSoft keeps the original receipt whatever we do. */
let RF = null;

/* WHAT EACH REASON MEANS FOR WHAT THE CLIENT OWES — Saif's split, Sep 10. The first two
   mean we took money we should not have, so the obligation stands. The last three close
   it or leave it standing conservatively. Mirrored from the server, which enforces it,
   and from the database, which constrains it. */
const RF_REASONS = [
  /* The fourth column completes the bold clause rather than repeating it: the rendered
     line is "<label> — <bold clause> <this>", and the first draft read "Policy cancelled
     — this closes the obligation. This closes the obligation. Nothing further is owed."
     Seen in the screenshot, not in the source. */
  ['charged_twice',    'Charged twice',      true,  'We took money we should not have, so the balance is not written off.'],
  ['wrong_amount',     'Wrong amount taken', true,  'We took money we should not have, so the balance is not written off.'],
  ['policy_cancelled', 'Policy cancelled',   false, 'Nothing further is owed on it.'],
  ['never_bound',      'Never bound',        false, 'Nothing further is owed on it.'],
  ['other',            'Other',              true,  'The safer default — say why below.'],
];

/* Can this row be refunded AT ALL? Mirrors the server's guards so the button is not
   offered where it can only fail — but the server re-checks every one of them, because
   a browser is not a gate. */

function openRefund(paymentId, clientNo){
  const c = CLIENT_CACHE[clientNo] || CLIENT_CACHE[ACTIVE_TAB];
  const p = c && (c.payments||[]).find(x => x.id === paymentId);
  if(!c || !p) return;
  /* notify: null until chosen. { channel:'email', to, source } or { channel:'none',
     skip_reason }. The button does not enable without it — "no silent info". */
  /* mode: null until the agent picks All or Part - both are shown, every time (Saif,
     Sep 15: "I don't see the partial refund - make it clear"). The email on file is
     pre-selected; it is still recorded as chosen, like every notice. */
  const onFile0 = ((c.contact && c.contact.emails) || []);
  RF = { id: paymentId, clientNo: clientNo, p: p, c: c, reason: null, carrier: null,
         amount: refundable(p), mode: null, typedAmt: '', step: null, note: '',
         notify: onFile0.length ? { channel: 'email', to: String(onFile0[0]).trim().toLowerCase(), source: 'on_file' } : null,
         typed: '', skip: '' };
  document.getElementById('refundSheet').classList.remove('hide');
  document.body.style.overflow = 'hidden';
  drawRefund();
}
function closeRefund(){
  RF = null;
  document.getElementById('refundSheet').classList.add('hide');
  document.body.style.overflow = '';
}
function rfPick(what, value){
  if(!RF) return;
  RF[what] = value; RF.step = null;
  drawRefund();
  /* a reason wants its note: keep the cursor in the box */
  if(what === 'reason'){ const t = document.getElementById('rfNote'); if(t && !String(RF.note || '').trim()) t.focus(); }
}
function rfStep(n){ if(!RF) return; RF.step = n; drawRefund(); }
/* HOW MUCH (stage 4, Sep 15). "All of it" is what is still refundable - earlier partials
   already off. "Part of it" opens a box; the amount is capped here and again on the
   server and again by Clover. The box is text with a decimal keyboard so the caret
   survives the redraw every keystroke causes. */
function rfMode(m){
  if(!RF) return;
  RF.mode = m;
  if(m === 'all'){ RF.amount = refundable(RF.p); RF.typedAmt = ''; RF.step = null; }
  else { RF.amount = rfParse(RF.typedAmt); RF.step = 1; }
  drawRefund();
  if(m === 'part'){ const i = document.getElementById('rfAmt'); if(i){ i.focus(); } }
}
function rfParse(v){ const n = Math.round(Number(String(v || '').replace(/[^0-9.]/g, '')) * 100) / 100; return Number.isFinite(n) ? n : 0; }
function rfAmt(v){
  if(!RF) return;
  RF.typedAmt = String(v || '');
  RF.amount = rfParse(v);
  RF.step = 1;   // stay here while typing; the number badge turns green when it is good
  drawRefund();
  const i = document.getElementById('rfAmt');
  if(i){ i.focus(); const L = i.value.length; try { i.setSelectionRange(L, L); } catch(e){} }
}
function rfAmtOk(){
  if(!RF) return false;
  const cap = refundable(RF.p);
  return RF.mode === 'all' || (RF.amount >= 0.01 && RF.amount <= cap + 0.004);
}
function rfNotify(kind, addr){
  if(!RF) return;
  if(kind === 'on_file') RF.notify = { channel:'email', to: String(addr||'').trim().toLowerCase(), source:'on_file' };
  else if(kind === 'typed') RF.notify = { channel:'email', to: String(RF.typed||'').trim().toLowerCase(), source:'typed' };
  else RF.notify = { channel:'none', skip_reason: String(RF.skip||'').trim() };
  RF.step = (kind === 'on_file') ? null : 4;
  drawRefund();
  const f = document.getElementById('rfTyped') || document.getElementById('rfSkip');
  if(f) f.focus();
}

function drawRefund(){
  if(!RF) return;
  const p = RF.p, c = RF.c;
  const isCard = /^(charge_live|charge_card|paylink_charge|terminal_charge)$/.test(String(p.kind||''));
  const name = (c.client && (c.client.business_name
    || [c.client.first_name, c.client.last_name].filter(Boolean).join(' '))) || ('Client ' + RF.clientNo);
  const first = String(name).split(' ')[0] || 'the client';
  const amt = RF.amount;
  const fee = p.fee_amount != null ? Number(p.fee_amount) : null;
  const cost = p.service_cost != null ? Number(p.service_cost) : null;
  const carrierName = p.carrier_name || 'the carrier';
  const reason = RF_REASONS.find(r => r[0] === RF.reason) || null;
  /* REQUEST MODE: no permission to issue, so this becomes a request for the owner.
     Same four questions, because the owner decides on the agent's answers. */
  const isReq = !c.can_refund;
  /* Under 25 minutes Clover VOIDS instead of refunding. Different operations, different
     settlement — the client sees the charge disappear rather than a refund arrive, so
     the agent has to be told which one they are about to do. Confirmed while probing. */
  const ageMin = Math.round((Date.now() - new Date(p.ts).getTime()) / 60000);
  const isVoid = isCard && isFinite(ageMin) && ageMin < 25;
  const verb = isVoid ? 'Void' : 'Refund';

  /* ---- the four answers ---- */
  const cap = refundable(p);
  const alreadyBack = Number(p.refunded) || 0;
  const collectedAmt = Number(p.collected != null ? p.collected : p.amount) || 0;
  const amtOk = RF.mode === 'all' || (RF.mode === 'part' && rfAmtOk());
  const a1 = !!RF.mode && amtOk;
  const a2 = !!RF.reason && !!String(RF.note || '').trim();
  const a3 = !!RF.carrier;
  const nz = RF.notify;
  const nzReady = !!(nz && (
    (nz.channel === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(nz.to || '')))
    || (nz.channel === 'none' && String(nz.skip_reason || '').trim())));
  const a4 = nzReady;
  const answered = [a1, a2, a3, a4];
  const nAnswered = answered.filter(Boolean).length;
  const firstOpen = answered.indexOf(false) + 1;          // 0 when all answered
  const open = RF.step || firstOpen || 0;
  const partialNow = RF.mode === 'part' && amtOk && amt + 0.004 < cap;
  const feeShare = fee != null ? (partialNow ? Math.round(fee * amt / (collectedAmt || 1) * 100) / 100 : fee) : null;
  const cShare = cost != null ? (partialNow ? Math.round(cost * amt / (collectedAmt || 1) * 100) / 100 : cost) : null;
  const onFile = ((c.contact && c.contact.emails) || []);

  /* one step: number, question, and either the controls (open), the answer (done) or
     nothing (not reached). Every header is a tap target, so any step can be reopened. */
  const step = (n, q, hint, body, done) => {
    const isOpen = open === n, isDone = answered[n - 1];
    return '<div class="rstep' + (isOpen ? ' open' : '') + (!isOpen && !isDone ? ' dim' : '') + '">'
      + '<div class="rnum' + (isDone ? ' done' : isOpen ? ' on' : '') + '" onclick="rfStep(' + n + ')">' + (isDone ? '✓' : n) + '</div>'
      + '<div class="rbody">'
      + '<div class="rq" onclick="rfStep(' + n + ')">' + q + (hint && isOpen ? ' <small>' + hint + '</small>' : '') + '</div>'
      + (isOpen ? body : isDone ? '<div class="rdone">' + done + ' <span class="rchg" onclick="rfStep(' + n + ')">change</span></div>' : '')
      + '</div></div>';
  };
  const radio = (on, onclick, t, m) => '<div class="rradio' + (on ? ' on' : '') + '" onclick="' + onclick + '"><div class="dot"></div><div><div class="t">' + t + '</div>' + (m ? '<div class="m">' + m + '</div>' : '') + '</div></div>';

  let h = '<div class="rhdr"><div><b style="font-size:18px">' + (isReq ? 'Ask for a refund' : verb + ' a payment') + '</b>'
    + '<div class="dim" style="font-size:13px">' + esc(name) + ' · client ' + esc(String(RF.clientNo)) + '</div></div>'
    + '<span class="rx" onclick="closeRefund()">✕</span></div>'
    + '<div class="rpay"><b>' + money(p.amount) + '</b><span>' + esc(p.purpose || '') + ' · ' + esc(String(p.ts||'').slice(0,10)) + '</span>'
    + '<span class="rpill">' + (isCard ? esc(p.ref || 'Card') : 'Cash') + '</span>'
    + (p.carrier_name ? '<span class="rpill">' + esc(p.carrier_name) + (cost != null ? ' ' + money(cost) : '') + (fee != null ? ' · Speedy ' + money(fee) : '') + '</span>' : '')
    + '</div>';
  if(isVoid){
    h += '<div class="warn">Taken <b>' + ageMin + ' minute' + (ageMin === 1 ? '' : 's') + ' ago</b> — Clover will <b>void</b> it, not refund it. '
      + 'Tell ' + esc(first) + ' the charge will <b>disappear</b>, not that a refund is coming.</div>';
  }
  if(isReq){
    h += '<div class="warn">You can ask for this refund but not issue it. <b>The owner</b> approves refunds — nothing below happens until they say yes; you will be told either way.</div>';
  }

  /* ---- 1 · HOW MUCH. Both choices in the open, every time: all of it, or part. ---- */
  {
    const body = '<div class="rchoice">'
      + radio(RF.mode === 'all', "rfMode('all')", 'All of it — ' + money(cap), alreadyBack > 0 ? money(alreadyBack) + ' went back earlier; this is what is left' : 'The whole payment')
      + radio(RF.mode === 'part', "rfMode('part')", 'Part of it…', 'A partial refund — you enter the amount' + (RF.reason === 'wrong_amount' ? '. Wrong amount usually means part of it — the difference' : ''))
      + '</div>'
      + (RF.mode === 'part'
          ? '<div class="ramt"><span style="font-size:15px;font-weight:700">$</span>'
            + '<input id="rfAmt" type="text" inputmode="decimal" placeholder="0.00" value="' + esc(RF.typedAmt) + '" oninput="rfAmt(this.value)" class="' + (amtOk ? '' : 'need') + '">'
            + '<span class="dim" style="font-size:13px">of ' + money(cap) + '</span></div>'
            + (amtOk
                ? '<div class="rsub"><b>Refunding ' + money(amt) + ' of ' + money(cap) + '.</b> '
                  + (amt + 0.004 >= cap ? 'That is everything that is left' : money(cap - amt) + ' of the payment stays with Speedy')
                  + (alreadyBack > 0 ? ' (' + money(alreadyBack) + ' went back earlier)' : '') + '.</div>'
                : '<div class="rsub" style="color:var(--red-ink)">Enter an amount between $0.01 and ' + money(cap) + '.</div>')
          : '');
    const done = RF.mode === 'part'
      ? '<b>' + money(amt) + '</b> of ' + money(cap) + (amt + 0.004 < cap ? ' — ' + money(cap - amt) + ' stays with Speedy' : '')
      : '<b>All of it</b> — ' + money(cap);
    h += step(1, 'How much', '', body, done);
  }

  /* ---- 2 · WHY, with the consequence under each choice and the note in the same step ---- */
  {
    const body = '<div class="rchoice">'
      + RF_REASONS.map(r => radio(RF.reason === r[0], "rfPick('reason','" + r[0] + "')", esc(r[1]),
          (r[2] ? esc(first) + ' still owes what ' + (c.client && c.client.business_name ? 'it' : 'they') + ' owed — ' : 'The obligation is gone — ') + esc(r[3]))).join('')
      + '</div>'
      + '<textarea id="rfNote" rows="2" class="' + (String(RF.note || '').trim() ? '' : 'need') + '" placeholder="In your words — the owner and the next person read this (required)">' + esc(RF.note || '') + '</textarea>';
    const done = '<b>' + esc(reason ? reason[1] : '') + '</b>' + (reason ? ' — ' + (reason[2] ? esc(first) + ' still owes what they owed' : 'the obligation is gone') : '')
      + (String(RF.note || '').trim() ? ' · “' + esc(String(RF.note).trim()) + '”' : '');
    h += step(2, 'Why is it going back?', 'this decides whether ' + esc(first) + ' still owes the money', body, done);
  }

  /* ---- 3 · THE CARRIER'S SHARE, named and priced ---- */
  {
    const q = cost != null && cost > 0
      ? 'Did ' + esc(carrierName) + ' give back its ' + money(cost) + '?'
      : 'Did the carrier give back its share?';
    const hint = partialNow && cost != null ? 'only the ' + money(cShare) + ' share of this refund is in play' : '';
    const body = '<div class="rchoice">'
      + radio(RF.carrier === 'yes', "rfPick('carrier','yes')", 'Yes, we got it back', 'The ' + money(cShare || 0) + ' carrier cost reverses too' + (partialNow ? '' : ' — this nets to nothing'))
      + radio(RF.carrier === 'no', "rfPick('carrier','no')", 'No, they kept it', money(cShare || 0) + ' is Speedy’s loss — it shows on Trust as a loss')
      + radio(RF.carrier === 'pending', "rfPick('carrier','pending')", 'Not yet', money(cShare || 0) + ' goes on the carrier recovery list until someone confirms')
      + '</div>';
    const done = RF.carrier === 'yes' ? '<b>Returned</b> — the ' + money(cShare || 0) + ' cost reverses'
      : RF.carrier === 'no' ? '<b>Kept it</b> — ' + money(cShare || 0) + ' is Speedy’s loss'
      : '<b>Not yet</b> — ' + money(cShare || 0) + ' on the recovery list';
    h += step(3, q, hint, body, done);
  }

  /* ---- 4 · TELL THE CLIENT. The email on file is pre-selected (Saif, Sep 15); every
     choice is still recorded on the row: which address, from the record or typed, who
     chose it, and what happened. Not telling them is allowed and recorded with a reason. */
  {
    const isTyped = nz && nz.channel === 'email' && nz.source === 'typed';
    const isNone = nz && nz.channel === 'none';
    const body = '<div class="rchoice">'
      + onFile.map(e => radio(nz && nz.channel === 'email' && nz.source === 'on_file' && nz.to === e,
          "rfNotify('on_file'," + JSON.stringify(e).replace(/"/g, '&quot;') + ')', 'Email ' + esc(e), 'On the record · sent the moment it goes through')).join('')
      + radio(isTyped, "rfNotify('typed')", onFile.length ? 'A different address…' : 'Type an address…', 'Recorded as typed by you, not from the record')
      + radio(isNone, "rfNotify('none')", 'Don’t — because…', 'The reason is recorded')
      + '</div>'
      + (!onFile.length && !(nz && nz.channel) ? '<div class="warn">No email on this client’s record. Type one, or say why they are not being told.</div>' : '')
      + (isTyped
          ? '<div style="margin-top:8px"><input id="rfTyped" type="email" placeholder="name@example.com" value="' + esc(RF.typed || '') + '"'
            + ' oninput="RF.typed=this.value;RF.notify.to=this.value.trim().toLowerCase()" onchange="drawRefund()"></div>'
            + '<div class="warn">This address is <b>not on the client’s record</b>. A mistyped address sends the client’s name and the amount to a stranger — check it.</div>'
          : isNone
            ? '<div style="margin-top:8px"><input id="rfSkip" placeholder="Why not? (required — this is recorded)" value="' + esc(RF.skip || '') + '"'
              + ' oninput="RF.skip=this.value;RF.notify.skip_reason=this.value.trim()" onchange="drawRefund()"></div>'
            : '');
    const done = nz && nz.channel === 'email'
      ? '<b>Email</b> ' + esc(nz.to || '') + (nz.source === 'typed' ? ' <span class="neg">(typed, not from the record)</span>' : ' (on file)')
      : '<b>Not told</b>' + (nz && nz.skip_reason ? ' — ' + esc(nz.skip_reason) : '');
    h += step(4, 'Tell ' + esc(first), '', body, done);
  }

  /* ---- WHAT WILL HAPPEN. Once, in sentences, filling in as the answers arrive. ---- */
  const wait = t => '<li><span class="rwait">' + t + '</span></li>';
  h += '<div class="rsum"><div class="rsumh">' + (isReq ? 'What will happen once the owner approves' : 'What will happen') + '</div><ul>'
    + (a1
        ? '<li><span><b>' + esc(first) + ' gets ' + money(amt) + ' back</b> '
          + (isCard ? (isVoid ? '— the charge is cancelled before it settles' : 'on the card used for the original payment, usually 2 to 5 business days') : '— hand back the cash')
          + (a4 && nz.channel === 'email' ? ', and is <b>emailed</b> at ' + esc(nz.to) + (nz.source === 'typed' ? ' <span class="neg">(typed)</span>' : '') + ' the moment it goes through' : '') + '.</span></li>'
        : wait('How much — answer step 1'))
    + (fee != null
        ? '<li><span>' + (partialNow ? '<b>' + money(feeShare) + '</b> of Speedy’s ' + money(fee) + ' fee' : 'Speedy’s <b>' + money(fee) + '</b> fee') + ' is <span class="neg">reversed</span> — it comes off <b>'
          + esc(p.commission_to_name || 'whoever earned it') + '</b>’s commission for <b>this month</b>, not the month of the charge.</span></li>'
        : '<li><span>This payment was never audited, so no commission has been released on it and there is none to reverse.</span></li>')
    + (a2 && reason
        ? '<li><span>' + esc(first) + ' <b>' + (reason[2] ? 'still owes' : 'no longer owes') + '</b> ' + (reason[2] ? 'what they owed; nothing is written off.' : 'anything on this — the obligation is closed.') + '</span></li>'
        : wait('Why — answer step 2'))
    + (cost != null
        ? (a3
            ? '<li><span>' + (RF.carrier === 'yes' ? 'The ' + money(cShare) + ' carrier cost is <b>reversed</b> too.'
                : RF.carrier === 'no' ? '<span class="neg">' + money(cShare) + ' is a loss</span> — ' + esc(carrierName) + ' keeps its premium; it shows on Trust as a loss.'
                : money(cShare) + ' goes on the <b>carrier recovery</b> list until someone confirms ' + esc(carrierName) + ' returned it.') + '</span></li>'
            : wait('Carrier share — answer step 3'))
        : '')
    + (a4 && nz.channel === 'none' ? '<li><span><span class="neg">' + esc(first) + ' is NOT told by us</span> — ' + esc(nz.skip_reason) + '.</span></li>'
       : !a4 ? wait('Client notice — answer step 4') : '')
    + '<li><span>A note goes on the HawkSoft file. The original receipt stays — nothing is erased.</span></li>'
    + '</ul></div>';

  /* ---- the button, the progress, cancel ---- */
  const ready = a1 && a2 && a3 && a4;
  h += '<div id="rfMsg" class="note" style="min-height:0"></div>'
    + '<button class="btn ' + (isReq ? 'btn-blue' : 'btn-red') + '" ' + (ready ? '' : 'disabled style="opacity:.4;cursor:not-allowed" ')
      + 'onclick="submitRefund()">'
      + (isReq ? 'Send to the owner for approval' : (a1 ? verb + ' ' + money(amt) + (ready ? ' to ' + esc(first) : '') : verb)) + '</button>'
    + '<div class="rprog"><span class="rbar"><i style="width:' + (nAnswered * 25) + '%"></i></span>' + nAnswered + ' of 4 answered'
      + (ready ? '' : ' · finish step ' + (firstOpen || open)) + '</div>'
    + '<div class="rcancel" onclick="closeRefund()">Cancel</div>';

  document.getElementById('rfBody').innerHTML = h;
  /* The typed note survives a redraw — every choice rebuilds this markup, and losing
     a half-typed sentence on the fourth click is the same fault the Staff editor had.
     Leaving the box (change) redraws so the step can close and the next one open. */
  const t = document.getElementById('rfNote');
  if(t){ t.oninput = () => { if(RF) RF.note = t.value; }; t.onchange = () => { if(RF){ RF.note = t.value; RF.step = null; drawRefund(); } }; }
}

async function submitRefund(){
  if(!RF) return;
  const msg = document.getElementById('rfMsg');
  const say = (t, bad) => { if(msg){ msg.textContent = t; msg.style.color = bad ? 'var(--red-ink)' : 'var(--green)'; } };
  const noteEl = document.getElementById('rfNote');
  const note = String((noteEl ? noteEl.value : RF.note) || '').trim();
  if(!RF.mode) return say('Say how much: all of it, or part of it.', true);
  if(!RF.reason || !RF.carrier) return say('Answer why, and whether the carrier is returning their share.', true);
  if(!note) return say('A reason in words is required.', true);
  /* One confirm, naming the amount and the person. Everything else was shown above; this
     is the last chance to notice the wrong row was opened. */
  const first = String((RF.c.client && (RF.c.client.business_name
    || [RF.c.client.first_name, RF.c.client.last_name].filter(Boolean).join(' '))) || 'the client').split(' ')[0];
  const isReq = !RF.c.can_refund;
  if(!rfAmtOk()) return say('Enter an amount between $0.01 and ' + money(refundable(RF.p)) + '.', true);
  const partOf = RF.amount + 0.004 < refundable(RF.p) ? ' (part of ' + money(refundable(RF.p)) + ')' : '';
  if(!isReq && !confirm('Send ' + money(RF.amount) + partOf + ' back to ' + first + '?\n\nThis cannot be undone from here.')) return;

  say(isReq ? 'Sending for approval…' : 'Refunding…');
  const btn = document.querySelector('#refundSheet .btn-red, #refundSheet .btn-blue');
  if(btn){ btn.disabled = true; btn.style.opacity = '.45'; }
  if(!RF.notify) return say('Say whether to tell the client.', true);
  const r = await PanelHost.post({ action: isReq ? 'request_refund' : 'refund_payment', payment_id: RF.id,
    reason: RF.reason, carrier: RF.carrier, note: note, notify: RF.notify, amount: RF.amount });
  if(r && r.ok && isReq){
    const done = RF.clientNo;
    closeRefund();
    await PanelHost.reload(done);
    alert(r.message || 'Sent to the owner for approval.');
    return;
  }
  if(r && r.ok){
    const done = RF.clientNo;
    closeRefund();
    /* Re-read rather than patching the card in place: the refund row, the parent's
       refunded total and total_owed all changed server-side, and a card assembled from
       three guesses is how two screens end up disagreeing about one number. */
    await PanelHost.reload(done);
    /* The outcome, in words, every time — including the two that used to be silent. */
    const cn = r.client_notice || {};
    const told = cn.result === 'sent' ? 'Email sent to ' + cn.to + '.'
      : cn.result === 'failed' ? 'EMAIL FAILED to ' + cn.to + ' (' + (cn.detail || 'unknown') + '). The client has NOT been told — call them.'
      : 'The client was not emailed' + (cn.skip_reason ? ' — ' + cn.skip_reason : '') + '.';
    alert(r.tell_the_client + '\n\n' + told
      + (r.hawksoft_note ? '' : '\n\nNote: the HawkSoft note did not file. Tell Saif.'));
    return;
  }
  if(btn){ btn.disabled = false; btn.style.opacity = ''; }
  say((r && (r.message || r.error)) || 'Could not refund that payment.', true);
}

/* ---------- Commission ownership ----------
   Whoever does the job earns it, so this defaults to the agent charging. The client's
   producer is shown as a PROMPT, never as a silent default: producer codes are
   historical and were wrong for roughly half the payments we checked. The producer
   itself is read-only and never rewritten by us. */
let PRODUCERS = {}, CHG_PRODUCER = null;
/* Who can be OFFERED a commission: active people only, since handing one to somebody
   who has left is a mistake with money attached. Inactive rows are still kept in
   ROSTER, because agentLabel has to render a departed agent's name on the payments
   they already wrote — the server follows the same rule for the same reason. */
const staffList = () => ROSTER
  .filter(s => s.active !== false)
  .filter(s => s.email !== 'tony@speedyins.com')        // info@ already represents Tony
  .map(s => ({ email: s.email, name: s.name }))
  .sort((a, b) => a.name.localeCompare(b.name));

/* ONE read, cached, and every caller awaits it — onCred for the branch and the name,
   fillCommission for the dropdown. STAFF_LOADED rather than a check on PRODUCERS,
   because a response can legitimately carry an empty producer map and would then be
   re-fetched on every charge. */
let STAFF_LOADED = false;
async function loadStaff(){
  if(STAFF_LOADED) return;
  try{
    const r = await api('portal_staff');
    if(r && r.ok){
      PRODUCERS = r.producers || {};
      if(Array.isArray(r.staff) && r.staff.length) ROSTER = r.staff;
      if(Array.isArray(r.branches) && r.branches.length) OFFICES = r.branches;
      if(r.me) ME = r.me;
      STAFF_LOADED = true;
    }
  }catch(e){}
  /* A FAILED READ MUST NOT EMPTY THE COMMISSION DROPDOWN. Falling back to just the
     signed-in agent keeps the one choice that is always correct — you can always earn
     your own commission — instead of an empty select that silently posts nothing. */
  if(!ROSTER.length && EMAIL){
    ROSTER = [{ email: EMAIL, name: (ME.name || EMAIL.split('@')[0]), active: true }];
  }
}
function agentLabel(email){
  const hit = ROSTER.find(s => s.email === email);
  return (hit && hit.name) || email;
}
function fillCommission(clientCache){
  const sel = chgEl('chgComm');
  const me = EMAIL;
  sel.innerHTML = staffList().map(s =>
    '<option value="' + esc(s.email) + '"' + (s.email === me ? ' selected' : '') + '>'
    + esc(s.name) + (s.email === me ? ' — you' : '') + '</option>').join('');
  sel.value = me;

  // producer prompt — only when the client's producer is somebody else
  const code = clientCache && clientCache.producer_code;
  CHG_PRODUCER = code ? (PRODUCERS[code] || null) : null;
  const note = chgEl('chgProdNote');
  if(CHG_PRODUCER && CHG_PRODUCER !== me){
    chgEl('chgProdText').innerHTML = 'HawkSoft shows <b>' + esc(agentLabel(CHG_PRODUCER)) + ' (' + esc(code) + ')</b> as this client\'s producer.';
    chgEl('chgGiveBtn').textContent = 'Give to ' + agentLabel(CHG_PRODUCER).split(' ')[0];
    note.classList.remove('hide');
  } else note.classList.add('hide');
}
function giveToProducer(){
  if(!CHG_PRODUCER) return;
  chgEl('chgComm').value = CHG_PRODUCER;
  onCommChange();
}
function onCommChange(){
  const v = chgEl('chgComm').value;
  const note = chgEl('chgProdNote');
  if(v !== EMAIL) note.classList.add('hide');
  else if(CHG_PRODUCER && CHG_PRODUCER !== EMAIL) note.classList.remove('hide');
}

/* ---- "This pays down an earlier payment" ----
   The charge sheet handles this going forward with "Pay this balance". Nothing handled
   it afterwards, so a payment taken as a fresh charge stayed a separate sale — sitting
   in the audit queue asking for proof it will never have, while the original still
   showed money outstanding that had arrived. It took a hand-written SQL UPDATE twice in
   two days. Reuses openBalances(), the same helper the charge sheet uses, rather than a
   second copy of the same arithmetic. */
async function linkBalance(paymentId, amount){
  const c = CLIENT_CACHE[ACTIVE_TAB];
  if(!c){ alert('Open the client again and retry.'); return; }
  const bals = openBalances(c).filter(b => b.id !== paymentId);
  /* and the sales this could be MORE money for (Sep 14): recent, not approved, not a balance row */
  const adds = addToCandidates(c).filter(p => p.id !== paymentId).map(p => ({ id: p.id, ts: p.ts, add: true, amount: Number(p.amount || 0), purpose: p.purpose || 'payment',
    got: p.collected != null ? Number(p.collected) : Number(p.amount || 0) }));
  if(!bals.length && !adds.length){ alert('No earlier payment on this client is showing a balance owed, and none is recent and still open to add to.'); return; }

  const all = bals.concat(adds);
  let pick = all[0];
  if(all.length > 1){
    const opts = all.map((b,i) => (i+1) + '. ' + (b.add
      ? '$' + b.amount.toFixed(2) + ' ' + b.purpose + ' from ' + String(b.ts).slice(0,10) + ' — add this payment to that sale'
      : '$' + b.owed.toFixed(2) + ' from ' + String(b.ts).slice(0,10) + ' — $' + b.left.toFixed(2) + ' still owed')).join('\n');
    const ans = prompt('Which earlier payment does this $' + Number(amount).toFixed(2) + ' belong to?\n\n'
      + opts + '\n\nEnter a number:');
    if(!ans) return;
    const idx = parseInt(ans, 10) - 1;
    if(!(idx >= 0 && idx < all.length)) return;
    pick = all[idx];
  }
  if(pick.add){
    const after = +(pick.got + Number(amount)).toFixed(2);
    if(!confirm('Add this $' + Number(amount).toFixed(2) + ' to the ' + pick.purpose + ' sale from ' + String(pick.ts).slice(0,10) + '?\n\n'
      + 'Paid so far on it:  $' + pick.got.toFixed(2) + '\n'
      + 'After this:         $' + after.toFixed(2) + '\n\n'
      + 'This $' + Number(amount).toFixed(2) + ' will no longer need its own audit; the proof, the carrier cost and the fee stay on the earlier payment, worked out from the $' + after.toFixed(2) + ' the client has now paid.\n\nAdd it?')) return;
    const r = await PanelHost.post({ action: 'link_balance', mode: 'add', payment_id: paymentId, parent_id: pick.id });
    if(r && r.ok){
      alert('Added. That sale now reads $' + Number(r.collected).toFixed(2) + ' paid by the client.');
      await PanelHost.changed(ACTIVE_TAB);
    } else alert((r && r.error) || 'Could not add it.');
    return;
  }

  /* Say what it does to the MONEY, not just to the record: linking raises the parent's
     collected total, which raises the released share of its commission. The server
     recomputes all of it from the ledger — these numbers are for the human.

     openBalances gives {id, ts, owed, got, left} — the OBLIGATION, what has been
     collected against it, and what is left. It does not carry the parent's own charge
     amount, so the balance is named by its date and total, which is the clearer way
     round anyway: $184.50 is what the client owed, $130.50 was only the first payment
     against it. */
  const after = +(pick.got + Number(amount)).toFixed(2);
  const left  = +(pick.owed - after).toFixed(2);
  const ok = confirm('Link this $' + Number(amount).toFixed(2) + ' to the balance from '
    + String(pick.ts).slice(0,10) + '?\n\n'
    + 'Total owed on it:   $' + pick.owed.toFixed(2) + '\n'
    + 'Collected so far:   $' + pick.got.toFixed(2) + '\n'
    + 'After this:         $' + after.toFixed(2) + '\n'
    + (left > 0.005 ? 'Still owed:         $' + left.toFixed(2) + '\n'
                    : 'That clears it in full.\n')
    + '\nThis $' + Number(amount).toFixed(2) + ' will no longer need its own audit, and the '
    + 'commission on the earlier payment releases further now that the money is in.\n\n'
    + 'Link them?');
  if(!ok) return;

  const r = await PanelHost.post({ action: 'link_balance', payment_id: paymentId, parent_id: pick.id });
  if(r && r.ok){
    alert('Linked. That payment now reads $' + Number(r.collected).toFixed(2) + ' of $'
      + Number(r.total_owed).toFixed(2)
      + (Number(r.still_owed) > 0.005 ? ' — $' + Number(r.still_owed).toFixed(2) + ' still owed.' : ' — paid in full.'));
    await PanelHost.changed(ACTIVE_TAB);
  } else alert((r && r.error) || 'Could not link it.');
}
/* "Client still owes more": set the total for the sale after the fact. The card and the
   charge sheet read total_owed, so from here on it behaves as a part payment. */
async function setTotalOwed(paymentId, collected, currentTotal){
  const ans = prompt('What does the client owe IN TOTAL for this sale?\n\nCollected so far: $' + Number(collected).toFixed(2)
    + (currentTotal > 0 ? '\nTotal on record:  $' + Number(currentTotal).toFixed(2) : '')
    + '\n\nEnter the total (carrier cost + Speedy fee):', currentTotal > 0 ? String(Number(currentTotal).toFixed(2)) : '');
  if(ans == null) return;
  const total = Number(String(ans).replace(/[^0-9.]/g, ''));
  if(!(total > 0)){ alert('Enter the total the client owes.'); return; }
  if(total < Number(collected) - 0.005){ alert('The total cannot be less than the $' + Number(collected).toFixed(2) + ' already collected.'); return; }
  const left = +(total - Number(collected)).toFixed(2);
  if(!confirm('Set the total for this sale to $' + total.toFixed(2) + '?\n\n'
    + 'Collected so far:  $' + Number(collected).toFixed(2) + '\n'
    + (left > 0.005 ? 'Still owed:        $' + left.toFixed(2) + '\n\nThe card will show it as owed and the next charge on this client will offer "Pay this balance". Commission releases as it is collected.' : 'That makes it paid in full.') + '\n\nSet it?')) return;
  const r = await PanelHost.post({ action: 'set_total_owed', payment_id: paymentId, total_owed: total });
  if(r && r.ok){
    alert('Set. That sale now reads $' + Number(r.collected).toFixed(2) + ' of $' + Number(r.total_owed).toFixed(2) + (Number(r.still_owed) > 0.005 ? ' — $' + Number(r.still_owed).toFixed(2) + ' still owed.' : ' — paid in full.'));
    await PanelHost.changed(ACTIVE_TAB);
  } else alert((r && r.error) || 'Could not set the total.');
}
async function unlinkBalance(paymentId, amount){
  if(!confirm('Undo this?\n\nThe $' + Number(amount).toFixed(2) + ' will stand on its own again, '
    + 'need its own audit, and the earlier payment will show that money as still owed.\n\nUnlink?')) return;
  const r = await PanelHost.post({ action: 'unlink_balance', payment_id: paymentId });
  if(r && r.ok){
    alert(r.message || 'Unlinked.');
    await PanelHost.changed(ACTIVE_TAB);
  } else alert((r && r.error) || 'Could not unlink it.');
}

/* Reassigning an existing payment. Giving away is allowed; taking is not —
   the server enforces it too, this is only the friendly half. */
async function reassignPayment(paymentId, currentOwner){
  await loadStaff();
  const opts = staffList().filter(s => s.email !== currentOwner)
    .map((s,i) => (i+1) + '. ' + s.name).join('\n');
  const pick = prompt('Who should earn this payment?\n\n' + opts + '\n\nEnter a number:');
  if(!pick) return;
  const idx = parseInt(pick, 10) - 1;
  const list = staffList().filter(s => s.email !== currentOwner);
  if(!(idx >= 0 && idx < list.length)) return;
  const to = list[idx];
  if(to.email === currentOwner){ alert('This payment already belongs to ' + to.name + '.'); return; }
  const r = await PanelHost.post({ action: 'reassign_commission', payment_id: paymentId, to_email: to.email });
  if(r && r.ok){
    alert('Commission moved to ' + r.name + '.');
    await PanelHost.changed(ACTIVE_TAB);
    PanelHost.todo();
  } else alert((r && r.error) || 'Could not change it.');
}

/* ---------- Wrong client ----------
   The money is right; only the record is wrong. Within 15 minutes the agent who took
   the payment fixes their own slip; after that Tony decides. Either way the Clover
   transaction is untouched and both HawkSoft records get a correction note. */
async function moveClient(paymentId, fromClientNo, amount){
  const q = prompt('This payment is on client #' + fromClientNo + '.\n\nWhich client number should it be on?');
  if(!q) return;
  const to = parseInt(String(q).replace(/\D/g,''), 10);
  if(!to){ alert('Enter the client number.'); return; }
  if(to === fromClientNo){ alert('That is the same client.'); return; }
  const why = prompt('Briefly, what happened? (the owner will see this)') || '';
  if(!confirm('Move $' + Number(amount||0).toFixed(2) + ' from client #' + fromClientNo + ' to #' + to + '?\n\n'
    + 'No money moves — the card charge stays exactly as it is. Both client records get a correction note.')) return;
  const r = await PanelHost.post({ action:'move_client', payment_id: paymentId, to_client: to, reason: why });
  if(!r || !r.ok){ alert((r && r.error) || 'Could not do that.'); return; }
  alert(r.pending ? r.message : 'Moved to client #' + r.to + '. Both records have a correction note.');
  await PanelHost.changed(ACTIVE_TAB);
  PanelHost.todo();
}

/* Partial payments. Blank "total owed" means paid in full — the common case needs no
   thought from the agent, and a balance only exists when they deliberately enter one.
   Commission then releases in proportion to what is actually collected. */
/* ---------- Paying down an earlier balance ----------
   A follow-up payment has to be LINKED to the charge it pays off, otherwise it looks
   like a separate sale: the original keeps showing money outstanding, commission never
   fully releases, and the agent is asked to audit a payment that has no carrier cost
   of its own. HawkSoft cannot create invoices, so the balance lives in our ledger. */
let CHG_BALANCE_OF = null;
/* ADD TO AN EARLIER PAYMENT (Saif, Sep 14). "The carrier asked for more, so I charged
   the client again" - that is not a balance the agent forgot to write down, it is a
   second payment on the SAME sale. So the box asks: is this more money for a sale
   already charged? A recent payment on this client that is not approved yet (and not
   itself a balance payment) can be picked; this charge then joins it - same purpose,
   one audit, the client's total for that sale raised to what they have now paid. */
let CHG_ADD_TO = null;
const ADD_WINDOW_DAYS = 45;
function addToCandidates(cache){
  const pays = (cache && cache.payments) || [];
  const bal = new Set(openBalances(cache).map(b => b.id));
  const cutoff = Date.now() - ADD_WINDOW_DAYS * 86400e3;
  return pays.filter(p => p.audit_status !== 'complete' && !p.balance_of && !p.refund_of
    && !/declin|fail|void|refund/i.test(String(p.kind || ''))
    && !['declined', 'link_sent', 'not_a_payment', 'void', 'refunded'].includes(String(p.audit_status || ''))
    && Number(p.amount) > 0 && new Date(p.ts).getTime() > cutoff && !bal.has(p.id));
}
function renderOpenBalance(cache){
  const box = chgEl('chgOpenBal');
  const bals = openBalances(cache);
  const adds = addToCandidates(cache);
  CHG_BALANCE_OF = null; CHG_ADD_TO = null;
  if(!bals.length && !adds.length){ box.classList.add('hide'); box.innerHTML = ''; return; }
  const who = p => String(p.agent || '').replace(/\s*\(.*$/, '').split(' ')[0];
  box.innerHTML = '<div style="font-size:13px;font-weight:700;color:var(--amber-ink)">' + (adds.length ? 'Is this more money for a sale already charged?' : 'This client still owes money') + '</div>'
    + bals.map(b =>
        '<div class="balrow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px">'
        + '<div><b style="font-size:13px">$' + b.left.toFixed(2) + ' still owed</b>'
        + '<div class="dim" style="font-size:12px">of $' + b.owed.toFixed(2) + ' from ' + esc(String(b.ts).slice(0,10)) + '</div></div>'
        + '<button type="button" class="btn btn-ghost" style="margin:0;padding:7px 12px;width:auto" '
        + 'onclick="applyToBalance(\'' + b.id + '\',' + b.left + ')">Pay this balance</button></div>').join('')
    + adds.map(p =>
        '<div class="addrow" style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:8px">'
        + '<div><b style="font-size:13px">$' + Number(p.amount).toFixed(2) + '</b> \u00b7 ' + esc(p.purpose || 'payment')
        + '<div class="dim" style="font-size:12px">' + esc(String(p.ts).slice(0,10)) + (who(p) ? ' \u00b7 ' + esc(who(p)) : '') + ' \u00b7 not approved yet</div></div>'
        + '<button type="button" class="btn btn-ghost" style="margin:0;padding:7px 12px;width:auto;white-space:nowrap" '
        + 'onclick="addToPayment(\'' + p.id + '\')">Add this payment to it</button></div>').join('')
    + '<div class="dim" id="chgBalPicked" style="font-size:12px;margin-top:8px">Or ignore this and charge something new.</div>';
  box.classList.remove('hide');
}
/* this charge joins an earlier payment: the purpose is theirs, the total is the sum */
function addToPayment(id){
  const c = CLIENT_CACHE[CHG.clientNo]; const p = ((c && c.payments) || []).find(x => x.id === id); if(!p) return;
  CHG_ADD_TO = id; CHG_BALANCE_OF = null;
  /* inherit the purpose, whole - "New business — Walk-in", "Other: broker fee" */
  const raw = String(p.purpose || '');
  const m = raw.match(/^(.*?)\s+\u2014\s+(.*)$/);
  const typed = raw.match(/^Other:\s*(.*)$/);
  const def = PURPOSES.find(x => x.k === (typed ? 'Other' : (m ? m[1] : raw))) || null;
  if(def){
    CHG_PURPOSE = def.k; CHG_SUB = m ? m[2] : '';
    if(def.typed) chgEl('chgOther').value = typed ? typed[1] : '';
  }
  chgEl('chgPurp').innerHTML = PURPOSES.map(x => '<button type="button" class="' + (x.k===CHG_PURPOSE?'sel':'') + '" onclick="pickPurpose(\'' + x.k + '\',this)">' + esc(x.k) + '</button>').join('');
  chgEl('chgOtherWrap').classList.toggle('hide', !chgPurposeDef().typed);
  renderChgSub();
  syncPurposeGate();
  fadePurpose(true);
  chgEl('chgTotal').value = '';
  pickFull(true, document.querySelector('#chgFull button'));
  const amt = parseFloat(String(chgEl('chgAmt').value).replace(/[^0-9.]/g,'')) || 0;
  const paid = (p.collected != null ? Number(p.collected) : Number(p.amount || 0));
  const box = chgEl('chgOpenBal');
  box.querySelectorAll('.addrow, .balrow').forEach(r => {
    if(!r.innerHTML.includes(id)) r.style.display = 'none';
    else { const b = r.querySelector('button'); if(b) b.outerHTML = '<span style="color:var(--green);font-size:13px;white-space:nowrap">✓ picked</span>'; }
  });
  chgEl('chgBalPicked').innerHTML = '<span style="color:var(--green)">\u2713 Adding to the sale from ' + esc(String(p.ts).slice(0,10)) + '</span>'
    + ' \u00b7 <span style="color:var(--blue-l);cursor:pointer;text-decoration:underline" onclick="clearAddTo()">not that</span>'
    + '<div id="chgAddNote" style="margin-top:6px;color:var(--green)">' + addNote(paid, amt) + '</div>';
  renderChgHsPreview();
}
/* the purpose is inherited from the sale being added to: shown, not pickable */
function fadePurpose(on){
  ['chgPurp', 'chgPurpSub', 'chgOtherWrap'].forEach(id => { const e = chgEl(id); if(!e) return; e.style.opacity = on ? '.45' : ''; e.style.pointerEvents = on ? 'none' : ''; });
  let n = chgEl('chgPurpInherit');
  if(on){ if(!n){ n = document.createElement('div'); n.id = 'chgPurpInherit'; n.className = 'dim'; n.style.cssText = 'font-size:12px;margin-top:4px'; chgEl('chgPurpSub').insertAdjacentElement('afterend', n); } n.textContent = 'same as the earlier payment'; }
  else if(n) n.remove();
}
function addNote(paid, amt){
  return 'This ' + (amt > 0 ? '$' + amt.toFixed(2) + ' ' : 'payment ') + 'joins it: the client will have paid <b>$' + (paid + amt).toFixed(2) + '</b> for that sale. '
    + 'The purpose and the audit stay on the earlier payment \u2014 one proof, one carrier cost, one fee.';
}
function clearAddTo(){
  CHG_ADD_TO = null;
  fadePurpose(false);
  renderOpenBalance(CLIENT_CACHE[CHG.clientNo]);
  syncPurposeGate();
  renderChgHsPreview();
}
function applyToBalance(id, left){
  CHG_BALANCE_OF = id;
  chgEl('chgAmt').value = left.toFixed(2);
  chgEl('chgTotal').value = '';           // the total lives on the original charge
  pickFull(true, document.querySelector('#chgFull button'));
  chgEl('chgBalPicked').innerHTML = '<span style="color:var(--green)">\u2713 This payment will pay down that balance</span>'
    + ' · <span style="color:var(--blue-l);cursor:pointer;text-decoration:underline" onclick="clearBalance()">not that</span>';
}
function clearBalance(){
  CHG_BALANCE_OF = null; CHG_ADD_TO = null;
  chgEl('chgBalPicked').textContent = 'Or ignore this and charge something new.';
}

function showBalance(){
  const amt = parseFloat(String(chgEl('chgAmt').value).replace(/[^0-9.]/g,'')) || 0;
  const tot = parseFloat(String(chgEl('chgTotal').value).replace(/[^0-9.]/g,'')) || 0;
  const box = chgEl('chgBal');
  if(tot > amt && amt > 0){
    const bal = tot - amt;
    box.innerHTML = 'Balance left <b>$' + bal.toFixed(2) + '</b>'
      + '<div class="dim" style="font-size:12px;margin-top:2px;color:var(--mute)">'
      + 'Commission releases as the balance is collected. The next payment applies to it.</div>';
    box.classList.remove('hide');
  } else if(tot > 0 && tot < amt){
    box.innerHTML = 'Total owed is less than the amount being collected — check the numbers.';
    box.classList.remove('hide');
  } else box.classList.add('hide');
}

function toggleFull(no){ ClientTabs.set(no, 'payments'); }   // kept for old links; the tabs own this now
/* One open at a time. Tapping the open row closes it; the index is per client, so
   switching tabs does not carry a selection across to another client's list. */
function togglePolicy(i){
  POLICY_OPEN[ACTIVE_TAB] = (POLICY_OPEN[ACTIVE_TAB] === i) ? null : i;
  renderPanel();
}
/* The complete policy record - lifted verbatim out of the old all-at-once block so
   nothing an agent could see before disappears, only where it renders changes. */
function policyDetailHtml(p){
  const ce = p.carrier_extras || {};
  const fmtD = d => d ? String(d).slice(0,10) : '—';
  const tmF = termMonths(p);
  const expiredF = isExpired(p);
  let h = '<div style="border-top:1px solid var(--hair);margin-top:9px;padding-top:9px">';
  const rows = [
    ['Type', p.lob || ce.type || '—'],
    ['Status', expiredF ? '⚠ Expired' : (p.status || '—')],
    ['Effective', fmtD(p.effective_date)],
    ['Expires', fmtD(p.expiration_date) + (expiredF ? ' (past)' : '')],
    ['Term premium', p.premium ? '$'+Number(p.premium).toLocaleString()+(tmF?' / '+tmF+'-mo':'') : '—'],
    ['Billing plan', ce.billingPlan || p.billing || '—'],
    ['Billing freq', ce.term || '—'],
  ];
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;margin-bottom:8px;font-size:13px">';
  for(const [k,v] of rows){
    const isExp = String(v).includes('Expired') || String(v).includes('(past)');
    h += '<div style="display:flex;justify-content:space-between;border-bottom:1px solid var(--hair);padding-bottom:3px"><span class="dim">'+k+'</span><b'+(isExp?' style="color:#ff8787"':'')+'>'+esc(v)+'</b></div>';
  }
  h += '</div>';
  h += '<div class="dim" style="font-size:12px;margin-bottom:8px">💡 Exact down payment &amp; monthly amounts are set by the carrier — check the carrier portal for the live schedule.</div>';
  if(ce.note){ h += '<div style="font-size:13px;margin-bottom:8px"><span class="dim">Note: </span>'+esc(ce.note)+'</div>'; }
  const drivers = ce.drivers || [];
  if(drivers.length){ h += '<div class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px">Drivers ('+drivers.length+')</div>';
    for(const d of drivers){
      const nm = [d.firstName, d.middleName, d.lastName].filter(Boolean).join(' ') || '(driver)';
      h += '<div style="background:var(--navy);border-radius:8px;padding:8px 11px;margin-bottom:5px;font-size:13px">'
        + '<b>'+esc(nm)+'</b>'+(d.relationship?' <span class="dim">'+esc(d.relationship)+'</span>':'')
        + '<div class="dim" style="font-size:12px;margin-top:2px">'
        + [d.dateOfBirth?'DOB '+String(d.dateOfBirth).slice(0,10):'', d.gender||'', d.maritalStatus||'',
           d.licenseNumber?('Lic '+(d.licenseState||'')+' '+d.licenseNumber):'', d.licenseDate?'since '+String(d.licenseDate).slice(0,10):'',
           d.occupation||''].filter(Boolean).join(' · ')
        + '</div></div>';
    } }
  const autos = ce.autos || [];
  if(autos.length){ h += '<div class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:8px 0 4px">Vehicles ('+autos.length+')</div>';
    for(const a of autos){
      const v = [a.year,a.make,a.model].filter(Boolean).join(' ');
      h += '<div style="background:var(--navy);border-radius:8px;padding:8px 11px;margin-bottom:5px;font-size:13px">'
        + '<b>'+esc(v)+'</b>'+(a.totalPremium?' <span style="color:var(--blue-l)">$'+Number(a.totalPremium).toLocaleString()+'</span>':'')
        + '<div class="dim" style="font-size:12px;margin-top:2px">'
        + [a.vin?'VIN '+a.vin:'', a.use?'Use: '+a.use:'', (a.personalInfo&&a.personalInfo.annualMiles)?a.personalInfo.annualMiles+' mi/yr':''].filter(Boolean).join(' · ')
        + '</div></div>';
    } }
  /* Upload straight onto this policy. Reuses carrier.html's documents-only mode -
     multi-file, drag-and-drop, per-file type, client-side downscaling, all already
     built and proven - rather than a second uploader in the portal. nopay=1 tells
     the server there is no charge behind this, so it must not attach the client's
     one open payment. */
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">'
    + '<div onclick="event.stopPropagation();openPolicyDocs(\'' + esc(p.policy_number || '') + '\',\'' + esc(p.hs_policy_guid || '') + '\')" '
    + 'style="border:1px solid var(--line);border-radius:9px;padding:9px;text-align:center;'
    + 'font-size:13px;font-weight:600;color:var(--blue-l);cursor:pointer">'
    + '\uff0b Documents</div>'
    /* Charging THIS policy, not "the client". The picker still shows every policy
       and the agent can change it - the preselect is a starting point, not a lock,
       because the receipt prints whatever is chosen and HawkSoft has no way to
       correct one after it is sent. */
    + '<div onclick="event.stopPropagation();chargeThisPolicy(\'' + esc(p.policy_number || '') + '\')" '
    + 'style="background:var(--red);color:#fff;border-radius:9px;padding:9px;text-align:center;'
    + 'font-size:13px;font-weight:700;cursor:pointer">Charge this policy</div>'
    + '</div>';
  return h + '</div>';
}

/* ID card, dec page, signed application - anything that belongs to the policy
   rather than to a payment. */
function chargeThisPolicy(policyNum){
  if(!ACTIVE_TAB) return;
  openCharge(ACTIVE_TAB, policyNum || null);
}

function openPolicyDocs(policyNum, policyGuid){
  if(!ACTIVE_TAB) return;
  stashHandoff();
  const tab = PanelHost.tab(ACTIVE_TAB);
  const q = new URLSearchParams({
    client: ACTIVE_TAB || '', name: (tab && tab.name) || '',
    policy: policyNum || '', policy_guid: policyGuid || '',
    docs: '1', nopay: '1',
  });
  PanelHost.carrier(q);
}

/* ===================== STAGE 3 — CHARGE INSIDE THE PORTAL =====================
   Reuses the SAME /api/hawksoft actions charge.html uses (charge_lookup, ecomm_config,
   charge_live, charge_cash, paylink_create). No new endpoints, no divergence.
   Money always uses the HawkSoft record, never the portal's cached Supabase card. */
/* PURPOSE (Saif, Sep 13). Two levels where a second word answers a real question:
   New business - HOW did it come in (required: that is the marketing answer); Monthly
   payment - late or not (optional). Measured before this list existed, last 60 days:
   118 of 333 charges were "Other: ..." and ~70 of those were a monthly payment typed
   by hand ("late mp", "mp", "monthly payment", "late payment"), 21 were reinstatements
   (two spellings), and agents typed the METHOD into the purpose ("mp mp cash").
   Down payment is gone: it was new business under another name (97 rows). */
const PURPOSES = [
  { k: 'New business',    sub: ['Walk-in', 'Referral', 'Online', 'Rewrite', 'Second policy', 'Other'], ask: 'How did this one come in?', required: true },
  { k: 'Monthly payment', sub: ['On time', 'Late', 'Late + fee', 'Last payment'], ask: 'Anything to add?', required: false },
  { k: 'Endorsement' }, { k: 'Renewal' }, { k: 'Reinstatement' }, { k: 'Cancellation' }, { k: 'DMV' },
  { k: 'Other', typed: true },
];
const METHODS  = [['card','Card'],['cash','Cash'],['link','Pay link'],['zelle','Zelle'],['other','Other'],['invoice','Open invoice']];
let CHG = null;            // { clientNo, confirmed } — one charge at a time
let CHG_PRESELECT = null;  // policy to open the picker on, for one charge only
/* The invoice the AGENT picked, or null for "no invoice". pickInv used to read the
   invoice, fill the amount box and throw the id away — no browser has ever sent an
   invoiceId. The server no longer guesses one, so if this is not sent, no accounting
   receipt is posted at all. null is the default and a deliberate answer. */
let CHG_PICKED_INV = null;
let CHG_PURPOSE = 'New business';
let CHG_SUB = '';          // the second word, when the purpose has one
let CHG_METHOD = 'card';
let cloverSDK = null, cloverMounted = false;
let _plUrl = '', _plMsg = '', _plEmail = '';
let LEDGER_ID = null;  // bridge_ledger row id of the charge just made — passed to the
                       // carrier page as payment_id so the audit closes the loop

const chgEl = id => document.getElementById(id);
function amtVal(){ return String(chgEl('chgAmt').value || '').replace(/,/g, '').trim(); }
function chgPurposeDef(){ return PURPOSES.find(p => p.k === CHG_PURPOSE) || PURPOSES[0]; }
/* What the receipt, HawkSoft and the Audit tab will read. "New business — Walk-in",
   "Monthly payment — Late", "Other: broker fee"; the em dash is the same joiner the
   server uses for the note, so the whole line reads as one phrase. */
function chgPurposeText(){
  const d = chgPurposeDef();
  if(d.typed){ const t = chgEl('chgOther').value.trim(); return t ? 'Other: ' + t : 'Other'; }
  return CHG_SUB ? d.k + ' \u2014 ' + CHG_SUB : d.k;
}
/* Why the charge cannot go yet, or null. Asked BEFORE any money path, so a charge is
   never taken with "New business" and no source, or "Other" and nothing typed - the
   two answers that make the purpose worth recording at all. */
function chgPurposeProblem(){
  const d = chgPurposeDef();
  if(d.typed && !chgEl('chgOther').value.trim()) return 'Say what this payment is for \u2014 it goes on the receipt.';
  if(d.sub && d.required && !CHG_SUB) return d.ask + ' Pick one under Purpose.';
  return null;
}
function renderChgSub(){
  const d = chgPurposeDef(), el = chgEl('chgPurpSub');
  if(!el) return;
  if(!d.sub){ el.classList.add('hide'); el.innerHTML = ''; return; }
  el.classList.remove('hide');
  el.innerHTML = '<div class="dim" style="font-size:11px;margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase">' + esc(d.ask)
    + (d.required ? '' : ' <span style="text-transform:none;letter-spacing:0">\u2014 optional</span>') + '</div>'
    + '<div class="chips">' + d.sub.map(s => '<button type="button" class="' + (s === CHG_SUB ? 'sel' : '') + '" onclick="pickChgSub(\'' + s.replace(/'/g, '') + '\',this)">' + esc(s) + '</button>').join('') + '</div>';
}
function pickChgSub(s, btn){
  CHG_SUB = (CHG_SUB === s && !chgPurposeDef().required) ? '' : s;   // optional rows can be un-picked
  document.querySelectorAll('#chgPurpSub button').forEach(x => x.classList.toggle('sel', x.textContent === CHG_SUB));
  syncPurposeGate();
  renderChgHsPreview();
}
/* What the picker looks like while a purpose is half-answered. New business without
   a source (or Other without text): the other purposes fade, the row that needs the
   answer lights up, the Charge button waits and says why. The moment it is answered,
   everything comes back. Same test as doCharge() uses - chgPurposeProblem() - so the
   button can never be live while the charge would be refused. */
function syncPurposeGate(){
  const problem = chgPurposeProblem();
  const d = chgPurposeDef();
  document.querySelectorAll('#chgPurp button').forEach(x => x.classList.toggle('faded', !!problem && !x.classList.contains('sel')));
  const sub = chgEl('chgPurpSub'); if(sub) sub.classList.toggle('need', !!problem && !!d.sub);
  const ow = chgEl('chgOtherWrap'); if(ow) ow.classList.toggle('need', !!problem && !!d.typed);
  const go = chgEl('chgGo'), why = chgEl('chgGoWhy');
  if(go) go.disabled = !!problem;
  if(why){ why.textContent = problem || ''; why.classList.toggle('hide', !problem); }
}
function chgNoteText(){ return chgEl('chgNote').value.trim(); }

/* Same guard as charge.html. The receipt is what the client keeps and HawkSoft has
   no receipt-modify endpoint, so the exact string is shown BEFORE charging and an
   odd-looking value is called out. Never blocks — sometimes it really is the number.
   A rule on long digit strings was tried and REMOVED: it fired on 4,668 of 45,621
   real policies (Infinity, Mapfre). A warning agents learn to ignore is worse than none.
   NOTE: this logic exists twice, here and in charge.html. That duplication is the
   reason the policy picker was missing from charge.html for months. Merge them. */
function policyLooksOdd(pn){
  if(!pn) return '';
  if(pn.indexOf('::') !== -1) return 'This looks like a carrier reference, not a policy number.';
  if(pn.length >= 60) return 'This is unusually long and may have been cut short.';
  return '';
}
function updatePolicyPreview(){
  const w = chgEl('chgPolWrap'), sel = chgEl('chgPolSel');
  const prev = chgEl('chgPolPrev'), val = chgEl('chgPolPrevVal'), odd = chgEl('chgPolOdd');
  if(!w || !sel || !prev || !val || !odd) return;
  if(w.classList.contains('hide')){ prev.classList.add('hide'); odd.classList.add('hide'); return; }
  const raw = sel.value || '';
  const pn = raw.startsWith('guid:') ? '' : raw;   // never show a guid as a policy number
  const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
  prev.classList.remove('hide');
  val.innerHTML = raw
    ? (pn ? ('Policy # <b>' + esc(label) + '</b>')
          : ('<b>' + esc(label) + '</b> — no number yet, files to that tab'))
    : '<b>No policy</b> — filing at client level';
  const msg = policyLooksOdd(pn);
  if(msg){
    odd.classList.remove('hide');
    odd.textContent = msg + " It will print on the client's receipt exactly as shown. Check HawkSoft if you are not sure — you can still continue.";
  } else { odd.classList.add('hide'); }
}

/* The selected value is either a policy NUMBER or 'guid:<uuid>'. These two split it
   so the number never carries a guid prefix onto a receipt. */
function chgPolicy(){
  const w = chgEl('chgPolWrap');
  if(w.classList.contains('hide')) return '';
  const v = chgEl('chgPolSel').value || '';
  return v.startsWith('guid:') ? '' : v;
}
function chgPolicyGuid(){
  const w = chgEl('chgPolWrap');
  if(w.classList.contains('hide')) return '';
  const v = chgEl('chgPolSel').value || '';
  return v.startsWith('guid:') ? v.slice(5) : '';
}

async function hsPost(body){
  const r = await fetch('/api/hawksoft', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-user-token': TOKEN },
    body: JSON.stringify(body)
  });
  if(r.status === 401) PanelHost.authExpired();
  return r.json();
}
function reauth(){ if(window.google) google.accounts.id.prompt(); }

// --- open / close ---
/* preselectPolicy: launched from a specific policy row, so the picker should open
   on that policy rather than the first in the list. The agent chose it already. */
async function openCharge(no, preselectPolicy){
  if(!no){
    /* An alert whose only job is to tell the agent off does nothing for them. The
       button always means "start a charge" - it just begins with "who?". Put the
       cursor in the search box so they are one step closer, not one step back. */
    const sb = document.getElementById('searchBox');
    if(sb){ sb.focus(); sb.scrollIntoView({ behavior:'smooth', block:'center' }); }
    const hint = document.getElementById('chargeHint');
    if(hint){
      hint.textContent = 'Search a client to charge \u2014 or add a new one.';
      hint.classList.remove('hide');
      setTimeout(() => hint.classList.add('hide'), 6000);
    }
    return;
  }
  CHG = { clientNo: no, confirmed: null };
  CHG_PURPOSE = 'New business'; CHG_SUB = ''; CHG_METHOD = 'card'; CHG_FULL = true; CHG_ADD_TO = null;
  fadePurpose(false);
  chgEl('chgResult').innerHTML = ''; LEDGER_ID = null;
  chgEl('chgBody').classList.add('hide');
  chgEl('chgLoading').classList.remove('hide');
  chgEl('chgAuthWarn').classList.add('hide');
  chgEl('chgOut').classList.add('hide');
  const tab = PanelHost.tab(no);
  chgEl('chgTitle').textContent = 'Charge — ' + (tab ? tab.name : '#'+no);
  chgEl('chgSub').textContent = '#' + no + ' · ' + PanelHost.office();
  chgEl('chargeSheet').classList.remove('hide');
  document.body.style.overflow = 'hidden';

  let j = null;
  try{ j = await hsPost({ action:'charge_lookup', clientId: parseInt(no,10) }); }
  catch(e){ j = { ok:false, error:String(e) }; }
  if(!j || !j.ok){
    chgEl('chgLoading').innerHTML = '<span style="color:#ff8787">Couldn\'t load #'+no+' from HawkSoft.</span> '
      + esc((j && j.error) || 'Try again, or use the charge page.');
    return;
  }
  if(!CLIENT_CACHE[no]){ await loadClient(no); }
  CHG.confirmed = j.result;
  chgEl('chgTitle').textContent = 'Charge — ' + (j.result.name || ('#'+no));
  chgEl('chgSub').innerHTML = chgSubHtml(j.result.clientNumber || no);
  chgEl('chgLoading').classList.add('hide');
  chgEl('chgBody').classList.remove('hide');
  await loadStaff();
  CHG_PRESELECT = preselectPolicy || null;
  renderChargeForm();
  fillCommission(CLIENT_CACHE[no]);
  renderOpenBalance(CLIENT_CACHE[no]);
  chgEl('chgAmt').focus();
  chgEl('chgAmt').oninput = showBalance;
}
function closeCharge(){
  chgEl('chargeSheet').classList.add('hide');
  document.body.style.overflow = '';
  CHG = null;
  chgEl('chgAmt').value = ''; chgEl('chgNote').value = '';
  chgEl('chgOther').value = ''; chgEl('chgAltRef').value = ''; chgEl('chgTotal').value = ''; chgEl('chgBal').classList.add('hide');
  chgEl('chgTotalWrap').classList.add('hide');
  document.querySelectorAll('#chgFull button').forEach((x, i) => x.classList.toggle('sel', i === 0));
  chgEl('chgGo').disabled = false;
  PanelHost.closed();   // the portal's loadHome: the tiles and the bell catch up
}

// --- form ---
/* Pulled out of renderChargeForm so the refresh control can repaint ONLY the
   dropdown. Re-running the whole form would rebuild the method chips and re-run
   fillCommission - on a money page nothing the agent already chose may move.
   keepValue re-selects a policy if it still exists after the rebuild. */
function renderPolicyPicker(keepValue){
  if(!CHG) return 0;
  const cached = CLIENT_CACHE[CHG.clientNo];
  const tabNo = p => {
    const i = p.carrier_extras && p.carrier_extras.policyIndex;
    return (i === 0 || i > 0) ? 'Tab ' + (Number(i) + 1) + ' · ' : '';
  };
  const byTab = (a, b) => Number((a.carrier_extras||{}).policyIndex ?? 999)
                        - Number((b.carrier_extras||{}).policyIndex ?? 999);
  /* Include policies with NO policy number. A brand-new tab has none until the
     carrier issues one, and that is exactly the policy someone is taking a down
     payment on today - Sammy, client 23822. 429 such policies across 373 clients.
     They were filtered out here, so a refresh that worked perfectly looked broken.
     A policy with neither a number nor a GUID is skipped: there would be nothing to
     file against. */
  const all  = ((cached && cached.policies) || [])
    .filter(p => p.policy_number || p.hs_policy_guid);
  /* GROUPED BY STATUS, LIVE FIRST. Client 7941 is why: six tabs, and the receipt
     for a brand-new ASPIRE policy went onto a 2023 ONWARD policy that expired in
     March 2024 - because the expired one sat above it in a flat list. HawkSoft
     cannot move a receipt, so that $191.88 is on the wrong policy permanently.
     Newest tab first within each group: the policy someone is charging is almost
     always the one just created. */
  const dead = p => isExpired(p) || /cancel|expir/i.test(String(p.status || ''));
  const byTabDesc = (a, b) => Number((b.carrier_extras||{}).policyIndex ?? -1)
                            - Number((a.carrier_extras||{}).policyIndex ?? -1);
  const insAll = all.filter(p => p.record_type !== 'dmv_service');
  const live   = insAll.filter(p => !dead(p) && p.policy_number).sort(byTabDesc);
  const fresh  = insAll.filter(p => !dead(p) && !p.policy_number).sort(byTabDesc);
  const gone   = insAll.filter(dead).sort(byTabDesc);
  const dmvs   = all.filter(p => p.record_type === 'dmv_service').sort(byTabDesc);
  const pols = live.concat(fresh, dmvs, gone);
  /* An unnumbered policy travels by GUID. The charge path matches on the number, so
     without this the receipt would file at client level while the agent believed it
     went to the tab - worse than hiding the option. */
  const polValue = p => p.policy_number || ('guid:' + p.hs_policy_guid);
  const opt  = p => '<option value="' + esc(polValue(p)) + '">' + tabNo(p)
      + esc(p.policy_number || 'no policy number yet')
      + ' — ' + esc(p.carrier || (p.record_type === 'dmv_service' ? 'DMV service' : ''))
      + (isExpired(p) ? ' \u2014 EXPIRED' : (/cancel/i.test(String(p.status||'')) ? ' \u2014 CANCELLED' : ''))
      + '</option>';
  const sel = chgEl('chgPolSel'), w = chgEl('chgPolWrap');
  if(pols.length){
    sel.innerHTML =
        (live.length  ? '<optgroup label="Active policies">'        + live.map(opt).join('')  + '</optgroup>' : '')
      + (fresh.length ? '<optgroup label="New — no policy number yet">' + fresh.map(opt).join('') + '</optgroup>' : '')
      + (dmvs.length  ? '<optgroup label="DMV services">'          + dmvs.map(opt).join('')  + '</optgroup>' : '')
      + (gone.length  ? '<optgroup label="Cancelled &amp; expired">' + gone.map(opt).join('') + '</optgroup>' : '')
      + '<option value="">No policy — file at client level</option>';
    /* A selection the agent already made outranks the launch URL. If the policy is
       gone we do NOT silently fall through to another one - the dropdown resets to
       its first entry and the preview line below it changes, which is visible. */
    /* Above three tabs, nothing is preselected. A glance at a pre-filled field is how
       a receipt lands on a policy HawkSoft cannot move it off - which is exactly what
       happened on 7941. Below that, preselecting is genuinely helpful. */
    const MANY = pols.length > 3;
    if(MANY){
      sel.insertAdjacentHTML('afterbegin',
        '<option value="" selected>Choose the policy… (' + pols.length + ' tabs)</option>');
    }
    const kept = keepValue && [].slice.call(sel.options).some(o => o.value === keepValue);
    if(kept){
      sel.value = keepValue;
    } else if(panelHL().armed && panelHL().policy && String(CHG.clientNo) === String(panelHL().client)){
      const want = panelHL().policy.trim().toUpperCase();
      const hit = pols.find(p => String(p.policy_number || '').trim().toUpperCase() === want);
      if(hit) sel.value = polValue(hit);
    }
    w.classList.remove('hide');
  } else {
    sel.innerHTML = '<option value="">No policy — file at client level</option>';
    w.classList.add('hide');
  }
  updatePolicyPreview();
  return pols.length;
}

/* ---------- Refresh from HawkSoft ----------
   Portal search and the policy picker read OUR Supabase tables, filled by the cron
   at 09:00 UTC (2am Pacific). HawkSoft has no webhooks. So a policy tab created in
   CMS ten minutes ago is invisible here until a sync runs - Sammy hit this trying
   to charge a DMV record he had just created.

   portal_refresh_clients ALREADY syncs policies as well as clients (runDeltaSync ->
   upsertHsClient returns both counts). It was simply unreachable: it only rendered
   inside the "No clients found" state, and Sammy's search worked fine. This is
   placement, not plumbing - no new endpoint, no schema change.

   mode 'card' repaints the whole client panel, which is safe because nothing is
   typed there. mode 'picker' repaints only the dropdown. */
const RF_BASE = 'border:1.5px solid var(--line);border-radius:9px;text-align:center;cursor:pointer;color:var(--mute)';
const RF_OK   = 'border:1.5px solid rgba(47,191,113,.45);background:rgba(47,191,113,.12);border-radius:9px;text-align:center;color:var(--green)';
const RF_WARN = 'border:1.5px solid rgba(245,166,35,.4);background:rgba(245,166,35,.12);border-radius:9px;text-align:center;color:var(--amber-ink)';

async function refreshHawkSoft(btnId, clientNo, mode){
  const pad = mode === 'card' ? 'padding:10px;font-size:13px;margin-top:8px'
                              : 'padding:9px;font-size:13px;margin-top:8px';
  /* renderPanel() rebuilds #clientPanel, so the node we started on is gone by the
     time we report. Always re-query by id rather than holding a reference. */
  const at = () => document.getElementById(btnId);
  const paint = (html, style) => { const b = at(); if(b){ b.innerHTML = html; b.setAttribute('style', style + ';' + pad); } };
  const rest = () => { const b = at(); if(b){ b.dataset.busy = ''; b.innerHTML = label(mode); b.setAttribute('style', RF_BASE + ';' + pad); } };

  const b0 = at();
  if(!b0 || b0.dataset.busy) return;      // no stacked syncs from a double tap
  b0.dataset.busy = '1';
  paint('Checking HawkSoft\u2026', RF_BASE);

  const numbers = n => new Set((((CLIENT_CACHE[n]||{}).policies)||[]).map(p => String(p.policy_number||'')));
  const before = numbers(clientNo);
  const keep = (mode === 'picker' && chgEl('chgPolSel')) ? chgEl('chgPolSel').value : null;

  const r = await api('portal_refresh_clients');
  if(!r || !r.ok){
    paint('Couldn\u2019t reach HawkSoft. Try again in a moment.', RF_WARN);
    setTimeout(rest, 6000);
    return;
  }
  /* Re-read the client even when r.skipped is true. The 60s cooldown is shared by
     all thirteen agents and lives in the database, so this agent can be blocked by
     someone else's run - but that run is global and may already have pulled the tab
     he is looking for. Telling him about a lock he did not hit would be noise. */
  const c = await api('portal_client&no=' + encodeURIComponent(clientNo));
  if(c && c.ok) CLIENT_CACHE[clientNo] = c;

  const gained = [].concat.apply([], [[...numbers(clientNo)].filter(x => !before.has(x))]).length;
  if(mode === 'card') renderPanel(); else renderPolicyPicker(keep);

  if(gained > 0){
    paint('\u2713 ' + gained + ' new polic' + (gained > 1 ? 'ies' : 'y') + ' added \u2014 check the list', RF_OK);
  } else {
    paint('Nothing new. Make sure the tab is saved in HawkSoft.', RF_BASE);
  }
  setTimeout(rest, 6000);
}
function label(mode){
  return mode === 'card' ? '\u21bb Refresh from HawkSoft' : '\u21bb New tab in HawkSoft? Refresh';
}
function chgRefresh(){ if(CHG && CHG.clientNo) refreshHawkSoft('chgRefresh', CHG.clientNo, 'picker'); }

function renderChargeForm(){
  const c = CHG.confirmed;

  // named insured / excluded-driver picker (same rule as charge.html)
  const ppl = Array.isArray(c.people) ? c.people : [];
  const np = chgEl('chgNamePick');
  if(ppl.length > 1){
    np.innerHTML = '<label>Charging which name? — defaults to the named insured</label>'
      + '<select id="chgWho" onchange="onChgName()">'
      + ppl.map(p => '<option value="'+esc(p.name)+'"'+(p.role==='named insured'?' selected':'')+'>'+esc(p.name)+' — '
          + (p.role==='named insured' ? '★ named insured' : p.role==='excluded' ? '⚠ EXCLUDED — do not charge' : 'active driver')
          + '</option>').join('')
      + '</select><div id="chgNameWarn" class="hide" style="color:var(--amber-ink);font-size:13px;margin-top:5px"></div>'
      + '<div style="height:12px"></div>';
  } else np.innerHTML = '';

  // open invoices
  const inv = chgEl('chgInv');
  const list = c.openInvoices || [];
  CHG_PICKED_INV = null;   // cleared on every open; it applies to THIS charge only
  if(list.length){
    inv.innerHTML = '<div style="font-size:11px;color:#7ee2a8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Open invoices — pick one to apply this payment to it</div>'
      + '<div class="chips" style="margin-bottom:12px">'
      + list.map((iv,i) => '<button type="button" onclick="pickInv('+i+',this)" style="text-align:left">'
          + '<b style="color:var(--ink);font-size:13px">$'+Number(iv.bal).toFixed(2)+'</b><br><span style="font-size:12px">'
          + esc(iv.num || 'Invoice') + (iv.dueDate ? ' · due '+esc(iv.dueDate) : '') + '</span></button>').join('')
      + '<button type="button" class="sel" onclick="pickInv(-1,this)" style="text-align:left">'
      + '<b style="color:var(--ink);font-size:13px">No invoice</b><br><span style="font-size:12px">just take the payment</span></button>'
      + '</div>';
  } else inv.innerHTML = '';

  chgEl('chgPurp').innerHTML = PURPOSES.map(p =>
    '<button type="button" class="'+(p.k===CHG_PURPOSE?'sel':'')+'" onclick="pickPurpose(\''+p.k+'\',this)">'+esc(p.k)+'</button>').join('');
  renderChgSub();
  syncPurposeGate();
  chgEl('chgMeth').innerHTML = METHODS.map(m =>
    '<button type="button" class="'+(m[0]===CHG_METHOD?'sel':'')+'" onclick="pickChgMethod(\''+m[0]+'\',this)">'+m[1]+'</button>').join('')
    + '<button type="button" disabled style="opacity:.45;cursor:default;border-style:dashed">Terminal — soon</button>';

  // Policy picker — built from the policies already loaded on this client tab.
  // charge_lookup does not return a policy number (charge.html gets it from HawkLink),
  // so the portal offers the real list instead of guessing.
  const cached = CLIENT_CACHE[CHG.clientNo];
  /* Cleared immediately: it applies to THIS opening only. Left set, the next
     charge on the same client would silently preselect a policy nobody chose. */
  renderPolicyPicker(CHG_PRESELECT);
  CHG_PRESELECT = null;

  applyMethodUI();
}
function onChgName(){
  const s = chgEl('chgWho'), warn = chgEl('chgNameWarn');
  if(!s || !CHG || !CHG.confirmed) return;
  CHG.confirmed.name = s.value;
  const excluded = s.options[s.selectedIndex].textContent.includes('EXCLUDED');
  warn.classList.toggle('hide', !excluded);
  if(excluded) warn.textContent = '⚠ This is an EXCLUDED driver — normally you charge the named insured. Confirm this is right.';
}
/* Nothing is preselected among the real invoices — the same rule the policy picker
   follows, and for the same reason: a glance at a pre-filled field is how money lands
   somewhere nobody chose, and HawkSoft cannot move a receipt once it is posted.
   "No invoice" is the default and is a real answer, not an absence. */
function pickInv(i, btn){
  document.querySelectorAll('#chgInv button').forEach(x => x.classList.remove('sel'));
  btn.classList.add('sel');
  if(i < 0){ CHG_PICKED_INV = null; renderChgHsPreview(); return; }
  const iv = CHG.confirmed.openInvoices[i];
  CHG_PICKED_INV = iv;     // the id is what the server needs — it used to be dropped here
  chgEl('chgAmt').value = Number(iv.bal).toFixed(2);
  if(iv.policyNumber){
    const sel = chgEl('chgPolSel');
    let found = [...sel.options].find(o => o.value === iv.policyNumber);
    if(!found){ sel.insertBefore(new Option(iv.policyNumber + ' — from invoice', iv.policyNumber), sel.firstChild); }
    sel.value = iv.policyNumber;
    chgEl('chgPolWrap').classList.remove('hide');
    updatePolicyPreview();
  }
  renderChgHsPreview();
}
/* What HawkSoft will receive, shown BEFORE the charge. Every line is permanent the
   moment the button is pressed: HawkSoft has no endpoint to modify a receipt, delete
   an attachment or edit a log note. Shown even when the client has no open invoices,
   because "no accounting receipt" is exactly what the agent needs to know then too.

   The METHOD is read here on purpose. A pay link is paid in the CLIENT's browser and
   the client never picks an invoice, so a link posts no accounting receipt whatever is
   selected above. Saying "applied to INV…" on a link would be a lie the agent only
   discovers days later. */
/* The amount box is the money. If the agent edits it away from the picked invoice's
   balance we ABSTAIN rather than send a partial application: we have never sent one,
   and HawkSoft may leave the remainder open, reject the receipt, or close the invoice
   and erase the rest. The SERVER enforces this — verifyInvoicePick compares the same
   two numbers — so this is only the agent seeing the outcome before they commit. */
function chgInvMismatch(){
  if(!CHG_PICKED_INV) return '';
  const cents = v => Math.round((parseFloat(v) || 0) * 100);
  const amt = cents(chgEl('chgAmt').value);
  const bal = cents(CHG_PICKED_INV.bal);
  if(amt === bal) return '';
  return '$' + (amt/100).toFixed(2) + ' does not match ' + esc(CHG_PICKED_INV.num || 'the picked invoice')
       + ' ($' + (bal/100).toFixed(2) + '), so nothing is applied';
}
function renderChgHsPreview(){
  const el = chgEl('chgHsPreview');
  if(!el) return;
  if(!CHG || !CHG.confirmed){ el.classList.add('hide'); return; }
  el.classList.remove('hide');
  let rows;
  if(CHG_METHOD === 'invoice'){
    rows = ['<b>No money moves</b> — what the client owes is recorded',
            'Log note on the client file: "OPEN INVOICE — $' + (parseFloat(amtVal()) > 0 ? parseFloat(amtVal()).toFixed(2) : '…') + ' owed"',
            'The next charge on this client offers <b>Pay this balance</b>; the audit starts with the first payment'];
  } else if(CHG_METHOD === 'link'){
    rows = ['A payment link is created and logged now',
            'When the client pays: log note + receipt PDF',
            '<b>No accounting receipt</b> — a client cannot pick an invoice, so nothing is applied'];
  } else if(CHG_PICKED_INV && !chgInvMismatch()){
    rows = ['Accounting receipt applied to <b>' + esc(CHG_PICKED_INV.num || 'the picked invoice') + '</b> — that invoice closes',
            'Log note on the client file',
            'Receipt PDF attached'];
  } else {
    const mism = chgInvMismatch();
    rows = ['Log note on the client file',
            'Receipt PDF attached',
            mism ? ('<b>No accounting receipt</b> — ' + mism)
                 : '<b>No accounting receipt</b> — open invoices stay open'];
  }
  el.innerHTML = '<div class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">What HawkSoft will receive</div>'
    + '<div style="font-size:13px;line-height:1.5">· For: <b>' + esc(chgPurposeText()) + '</b></div>'
    + (function(){
        if(CHG_FULL) return '';
        const amt = parseFloat(String(chgEl('chgAmt').value).replace(/[^0-9.]/g,'')) || 0;
        const tot = parseFloat(String(chgEl('chgTotal').value).replace(/[^0-9.]/g,'')) || 0;
        return '<div style="font-size:13px;line-height:1.5;color:var(--red-ink)">· <b>Part payment</b>'
          + (tot > amt && amt > 0 ? ' \u2014 ' + money(amt) + ' of ' + money(tot) + ', <b>' + money(tot - amt) + ' still owed</b>' : ' \u2014 total not entered yet') + '</div>';
      })()
    + rows.map(r => '<div style="font-size:13px;line-height:1.5">· ' + r + '</div>').join('');
}
let CHG_FULL = true;   // the answer to "paid in full?"; false shows the total box
function pickFull(full, btn){
  CHG_FULL = !!full;
  document.querySelectorAll('#chgFull button').forEach(x => x.classList.remove('sel'));
  if(btn) btn.classList.add('sel');
  chgEl('chgTotalWrap').classList.toggle('hide', CHG_FULL);
  if(CHG_FULL){ chgEl('chgTotal').value = ''; chgEl('chgBal').classList.add('hide'); }
  else chgEl('chgTotal').focus();
  showBalance(); renderChgHsPreview();
}
/* Why the charge cannot go yet because of the total, or null. A part payment with no
   total, or a total no bigger than the payment, is refused before any money path. */
function chgTotalProblem(){
  if(CHG_FULL) return null;
  const amt = parseFloat(String(chgEl('chgAmt').value).replace(/[^0-9.]/g,'')) || 0;
  const tot = parseFloat(String(chgEl('chgTotal').value).replace(/[^0-9.]/g,'')) || 0;
  if(!tot) return 'Enter the total the client owes for this sale \u2014 or choose Paid in full.';
  if(tot <= amt) return 'The total owed has to be more than the amount being collected \u2014 or choose Paid in full.';
  return null;
}
function pickPurpose(p, btn){
  CHG_PURPOSE = p; CHG_SUB = '';
  document.querySelectorAll('#chgPurp button').forEach(x => x.classList.remove('sel'));
  btn.classList.add('sel');
  chgEl('chgOtherWrap').classList.toggle('hide', !chgPurposeDef().typed);
  renderChgSub();
  syncPurposeGate();
  if(chgPurposeDef().typed) chgEl('chgOther').focus();
  renderChgHsPreview();
}
function pickChgMethod(m, btn){
  CHG_METHOD = m;
  document.querySelectorAll('#chgMeth button').forEach(x => x.classList.remove('sel'));
  btn.classList.add('sel');
  chgEl('chgResult').innerHTML = '';
  applyMethodUI();
}
function applyMethodUI(){
  const isCard = CHG_METHOD === 'card';
  const isAlt = (CHG_METHOD === 'zelle' || CHG_METHOD === 'other');
  /* OPEN INVOICE: no money moves - the amount is what the client owes, the "paid in
     full?" question does not apply, the button says what it does */
  const isInv = CHG_METHOD === 'invoice';
  chgEl('chgCard').classList.toggle('hide', !isCard);
  chgEl('chgAltWrap').classList.toggle('hide', !isAlt);
  { const lab = document.querySelector('label[for="chgAmt"]'); if(lab) lab.textContent = isInv ? 'Amount the client owes' : 'Amount'; }
  { const fw = chgEl('chgFull') && chgEl('chgFull').parentElement; if(fw){ fw.style.display = isInv ? 'none' : ''; } }
  if(isInv){ pickFull(true, document.querySelector('#chgFull button')); }
  if(isAlt){
    chgEl('chgAltLabel').textContent = (CHG_METHOD === 'zelle' ? 'Zelle confirmation / reference' : 'Payment reference') + ' — optional';
    chgEl('chgAltRef').placeholder = CHG_METHOD === 'zelle' ? 'Zelle conf # or sender name' : 'money order #, check #, other';
  }
  chgEl('chgGo').textContent = CHG_METHOD === 'link' ? 'Create payment link' : isInv ? 'Record open invoice' : 'Charge';
  renderChgHsPreview();   // the preview depends on the method — a link applies no invoice
  if(isCard) initPortalClover();
}

// Clover card fields — mounted ONCE, never unmounted (sheet lives outside #clientPanel)
async function initPortalClover(){
  if(cloverMounted) return true;
  const hint = chgEl('chgCardHint');
  try{
    const cfg = await hsPost({ action:'ecomm_config' });
    if(!cfg.ok || !cfg.pk){ hint.textContent = 'Card fields unavailable — CLOVER_ECOMM keys not set.'; return false; }
    if(!window.Clover){ hint.textContent = 'Clover SDK failed to load — refresh the page.'; return false; }
    cloverSDK = new Clover(cfg.pk, { merchantId: cfg.merchantId });
    const el = cloverSDK.elements();
    const styles = { body:{fontSize:'16px'}, input:{fontSize:'16px',color:'#111827',height:'44px',lineHeight:'44px',padding:'0'}, '::placeholder':{color:'#9ca3af'} };
    el.create('CARD_NUMBER', styles).mount('#pCardNumber');
    el.create('CARD_DATE', styles).mount('#pCardDate');
    el.create('CARD_CVV', styles).mount('#pCardCvv');
    el.create('CARD_POSTAL_CODE', styles).mount('#pCardZip');
    cloverMounted = true;
    return true;
  }catch(e){ hint.textContent = 'Card fields failed to load: ' + e; return false; }
}

// --- charge ---
function chgSay(t){ const o = chgEl('chgOut'); o.classList.remove('hide'); o.textContent = t; }
function chgQuiet(){ chgEl('chgOut').classList.add('hide'); chgEl('chgOut').textContent = ''; }
function chgFail(msg){
  chgQuiet();
  chgEl('chgResult').innerHTML = '<div class="res bad"><div style="font-size:15px;font-weight:800;margin-bottom:4px">Not completed</div>'
    + '<div style="font-size:13px">' + esc(msg) + '</div></div>';
  chgEl('chgGo').disabled = false;
  syncPurposeGate();
}
function doCharge(){
  if(!CHG || !CHG.confirmed) return;
  const amt = amtVal();
  if(!(parseFloat(amt) > 0)){ chgSay('Enter the amount first.'); return; }
  const pp = chgPurposeProblem(); if(pp){ chgSay(pp); return; }
  const tp = chgTotalProblem(); if(tp){ chgSay(tp); return; }
  if(CHG_METHOD === 'card') return chargeCardPortal(amt);
  if(CHG_METHOD === 'link') return createLinkPortal(amt);
  if(CHG_METHOD === 'invoice') return openInvoicePortal(amt);
  return chargeCashPortal(amt);
}
/* the open invoice: recorded, not collected */
async function openInvoicePortal(amt){
  const btn = chgEl('chgGo');
  chgEl('chgResult').innerHTML = ''; btn.disabled = true;
  chgSay('Recording the open invoice\u2026');
  try{
    const j = await hsPost(Object.assign({ action:'invoice_open' }, baseBody(amt)));
    if(j.ok){
      LEDGER_ID = j.ledgerId || null;
      chgQuiet();
      const c = CHG.confirmed;
      chgEl('chgBody').classList.add('hide');
      chgEl('chgResult').innerHTML = '<div class="res good">'
        + '<div style="font-size:15px;font-weight:800;color:var(--amber-ink)">Open invoice recorded</div>'
        + '<div style="font-size:28px;font-weight:800;margin:6px 0 10px">$' + parseFloat(amt).toFixed(2) + ' <span class="dim" style="font-size:13px;font-weight:400">owed</span></div>'
        + '<div class="kv"><span class="muted">Client</span><b>' + esc(c.name || '') + ' \u00b7 #' + c.clientNumber + '</b></div>'
        + '<div class="kv"><span class="muted">For</span><b>' + esc(chgPurposeText()) + '</b></div>'
        + '<div class="kv"><span class="muted">Collected</span><b>$0.00</b></div>'
        + '<div class="dim" style="font-size:12px;margin-top:8px">Nothing was charged. A log note is on the HawkSoft record; the balance is on the client card. When the client pays, open Charge and tap <b>Pay this balance</b> \u2014 the audit starts with that first payment.</div>'
        + '<button class="btn btn-ghost" onclick="closeCharge()">Done</button></div>';
    } else chgFail(j.error || 'Could not record the invoice.');
  }catch(e){ chgFail(String(e)); }
}
function baseBody(amt){
  const c = CHG.confirmed;
  return { clientId: c.clientNumber, clientName: c.name || '', amount: amt,
    purpose: chgPurposeText(), note: chgNoteText(), policyNumber: chgPolicy(),
    policyGuid: chgPolicyGuid(),
    clientEmail: (c.emails && c.emails[0]) || '', office: PanelHost.office(),
    /* The agent's invoice pick. charge_live and charge_cash apply it; paylink_create
       ignores it server-side, which is why the preview says so for a link. */
    invoiceId: CHG_PICKED_INV ? CHG_PICKED_INV.id : '',
    commissionTo: chgEl('chgComm').value || EMAIL,
    totalOwed: chgEl('chgTotal').value || '',
    balanceOf: CHG_BALANCE_OF || '',
    addTo: CHG_ADD_TO || '',        // this charge joins that earlier payment (same sale)
    producerCode: (CLIENT_CACHE[CHG.clientNo] && CLIENT_CACHE[CHG.clientNo].producer_code) || '' };
}
async function chargeCardPortal(amt){
  const btn = chgEl('chgGo');
  if(!cloverSDK){ chgSay('Card fields not ready — switch methods and back, or refresh.'); return; }
  chgEl('chgResult').innerHTML = ''; btn.disabled = true;
  chgSay('Securing card with Clover…');
  try{
    const tk = await cloverSDK.createToken();
    if(tk && tk.errors && Object.keys(tk.errors).length){ chgSay('Card error: ' + Object.values(tk.errors).join(' · ')); btn.disabled = false; return; }
    if(!tk || !tk.token){ chgSay('Could not read the card — check the fields.'); btn.disabled = false; return; }
    chgSay('Charging card…');
    const j = await hsPost(Object.assign({ action:'charge_live', source: tk.token }, baseBody(amt)));
    if(j.ok){
      LEDGER_ID = j.ledgerId || null;
      const ch = (j.results && j.results.charge) || {};
      showChargeResult(amt, [
        ['Card', (ch.brand || 'CARD') + ' •••• ' + (ch.last4 || '')],
        ['Clover transaction', ch.id || j.txnId || ''],
      ]);
    } else chgFail(j.error || 'The charge did not go through. The card was not billed twice — try again or use another card.');
  }catch(e){ chgFail(String(e)); }
}
async function chargeCashPortal(amt){
  const btn = chgEl('chgGo');
  const label = CHG_METHOD === 'zelle' ? 'Zelle' : CHG_METHOD === 'other' ? 'Other' : 'Cash';
  chgEl('chgResult').innerHTML = ''; btn.disabled = true;
  chgSay('Recording ' + label + ' payment…');
  try{
    const j = await hsPost(Object.assign({ action:'charge_cash', payMethod: label,
      altRef: (CHG_METHOD === 'cash' ? '' : chgEl('chgAltRef').value.trim()) }, baseBody(amt)));
    if(j.ok){ LEDGER_ID = j.ledgerId || null;
      showChargeResult(amt, [['Method', label], ['Reference', j.ref || '']]); }
    else chgFail(j.error || 'One or more HawkSoft steps failed.');
  }catch(e){ chgFail(String(e)); }
}
function showChargeResult(amt, rows){
  chgQuiet();
  const c = CHG.confirmed;
  const money2 = '$' + parseFloat(amt).toFixed(2);
  chgEl('chgBody').classList.add('hide');
  chgEl('chgResult').innerHTML = '<div class="res good">'
    + '<div style="font-size:15px;font-weight:800;color:var(--green)">✓ Payment recorded</div>'
    + '<div style="font-size:28px;font-weight:800;margin:6px 0 10px">' + money2 + '</div>'
    + '<div class="kv"><span class="muted">Client</span><b>' + esc(c.name || '') + ' · #' + c.clientNumber + '</b></div>'
    + '<div class="kv"><span class="muted">For</span><b>' + esc(chgPurposeText()) + '</b></div>'
    + '<div class="kv"><span class="muted">Office</span><b>' + esc(PanelHost.office()) + '</b></div>'
    + rows.filter(r => r[1]).map(r => '<div class="kv"><span class="muted">' + r[0] + '</span><b>' + esc(r[1]) + '</b></div>').join('')
    + '<div class="dim" style="font-size:12px;margin-top:8px">Receipt, branded PDF and log note filed to the HawkSoft record.</div>'
    + '<a href="' + carrierLink(parseFloat(amt).toFixed(2)) + '"' + PanelHost.carrierAttr() + ' onclick="stashHandoff()" style="display:block;text-align:center;background:var(--amber);color:#2a1a00;padding:12px;border-radius:11px;font-weight:700;text-decoration:none;font-size:14px;margin-top:12px">Next → Carrier payment &amp; documents</a>'
    + '<button class="btn btn-ghost" onclick="closeCharge()">Save &amp; finish later</button>'
    + '<div class="dim" style="font-size:12px;text-align:center;margin-top:2px">The payment is saved either way. Until the carrier cost and proof are added, it stays in your unfinished list — and commission isn\'t earned yet.</div>'
    + '</div>';
}
function carrierLink(amt){
  const c = CHG.confirmed || {};
  /* an added charge has no audit of its own: the proof goes on the earlier payment,
     and "paid" is what the client has now paid for the whole sale */
  let payId = LEDGER_ID || '', paid = amt;
  if(CHG_ADD_TO){
    const cc = CLIENT_CACHE[CHG.clientNo]; const par = ((cc && cc.payments) || []).find(x => x.id === CHG_ADD_TO);
    payId = CHG_ADD_TO;
    if(par) paid = ((par.collected != null ? Number(par.collected) : Number(par.amount || 0)) + Number(amt || 0)).toFixed(2);
  }
  const p = new URLSearchParams({ client: c.clientNumber || '', name: c.name || '', paid: paid,
    method: 'client paid', policy: chgPolicy() || (c.policyNumber || ''),
    policy_guid: (c.policyGuid || c.policyId || ''), payment_id: payId });
  return panelCarrierHref(p);
}
function stashHandoff(){ try{ if(TOKEN) localStorage.setItem('speedy_handoff_tok', TOKEN); }catch(e){} }

// --- pay link ---
async function createLinkPortal(amt){
  const btn = chgEl('chgGo');
  chgEl('chgResult').innerHTML = ''; btn.disabled = true; chgSay('Creating link…');
  try{
    const j = await hsPost(Object.assign({ action:'paylink_create' }, baseBody(amt)));
    btn.disabled = false;
    if(!j.ok){ chgFail(j.error || 'Could not create the link.'); return; }
    chgQuiet();
    const c = CHG.confirmed;
    const first = ((c.name || '').split(',').pop() || '').trim().split(' ')[0] || 'there';
    const amtStr = '$' + parseFloat(amt).toFixed(2);
    _plUrl = j.url;
    _plMsg = 'Hi ' + first + ' — Speedy Insurance secure payment\nAmount: ' + amtStr + '\nFor: ' + chgPurposeText() + '\n\nPay here (valid 72 hours):\n' + j.url;
    _plEmail = 'Hi ' + first + ',\n\nHere is your secure payment link from Speedy Insurance Agency.\n\nAmount: ' + amtStr
      + '\nFor: ' + chgPurposeText() + '\nValid: 72 hours\n\nPay here:\n' + j.url
      + '\n\nYour card details are entered directly with our secure payment processor — Speedy Insurance never sees or stores them. A receipt is filed to your account automatically.\n\nSpeedy Insurance Agency\n(951) 472-0927 · speedyins.com';
    const phone = (c.phones && c.phones[0]) ? String(c.phones[0]).replace(/\D/g,'') : '';
    chgEl('chgResult').innerHTML = '<div class="res good">'
      + '<div style="font-size:15px;font-weight:800;color:var(--green)">Payment link ready</div>'
      + '<div style="word-break:break-all;font-size:13px;color:#c9d2f0;margin:8px 0">' + esc(j.url) + '</div>'
      + '<button class="btn btn-blue" onclick="copyTxt(_plUrl,this)">Copy link</button>'
      + '<button class="btn btn-ghost" onclick="copyTxt(_plMsg,this)">Copy text message</button>'
      + (phone ? '<a class="btn btn-ghost" style="text-decoration:none" href="sms:' + phone + '?body=' + encodeURIComponent(_plMsg) + '">Text to ' + esc(first) + '</a>' : '')
      + '<button class="btn btn-ghost" onclick="emailLink()">Email to client (Gmail)</button>'
      + '<div class="dim" id="chgGmailHint" style="font-size:12px;margin-top:8px;display:none">Email copied ✓ — in the Gmail window click into the body, press Ctrl+V, then Send.</div>'
      + '<div class="dim" style="font-size:12px;margin-top:8px">When the client pays, the receipt, PDF and log file automatically — marked as sent by you.</div>'
      + '<button class="btn btn-ghost" onclick="closeCharge()">Close</button>'
      + '</div>';
  }catch(e){ chgFail(String(e)); }
}
function copyTxt(t, b){
  navigator.clipboard.writeText(t).then(() => { if(b){ const o = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => b.textContent = o, 1200); } }, () => {});
}
async function emailLink(){
  try{ await navigator.clipboard.writeText(_plEmail); const h = chgEl('chgGmailHint'); if(h) h.style.display = 'block'; }catch(e){}
  const c = CHG.confirmed || {};
  const to = (c.emails && c.emails[0]) ? '&to=' + encodeURIComponent(c.emails[0]) : '';
  window.open('https://mail.google.com/mail/?view=cm&fs=1' + to + '&su=' + encodeURIComponent('Your Speedy Insurance payment link'), '_blank', 'noopener');
}
