/* THE PAYMENT CARD — one renderer for the agent portal and the Console (Sep 13).
   Saif: "when we are on the Console and click on the client it shows different from
   the Portal." It did: the Console had a bare ledger table (raw kinds, no audit state,
   no documents, no refund or review state, no "client emailed" line). This file is
   the portal's payHistoryHtml and every helper it calls, lifted verbatim, with the
   page's globals turned into opts:
     PayCard.html(clientCard, { me, clientNo, actions })
   actions:false renders the card read-only - the Console's mode - so no button ever
   points at a handler that page does not have. Document chips call openPortalDoc,
   which lives here too and uses the page's api(). Loaded by both pages as a plain
   script; there is no bundler. Both pages load paycard.css beside it. */
(function(){
function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
const money = n => { const v = Number(n||0); return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); };
function docType(d){ return d.doc_type || d.kind || 'document'; }
function docTypeLabel(k){
  return k === 'carrier_receipt' ? 'Carrier receipt'
       : k === 'client_receipt'  ? 'Speedy receipt'
       : k === 'carrier_application' ? 'Signed application'
       : k === 'carrier_endo' ? 'Signed endorsement'
       : k === 'cancellation' ? 'Cancellation request'
       : k === 'dmv_receipt' ? 'DMV receipt'
       : String(k).replace(/_/g, ' ');
}
function bytesLabel(b){
  if(!b) return '';
  return b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b/1024) + ' KB' : (b/1048576).toFixed(1) + ' MB';
}
function uploaderShort(email){
  const local = String(email || '').split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : '';
}
function noticeLineHtml(n){
  const st = 'font-size:11px;margin-top:3px;';
  if(!n) return '<div style="' + st + 'color:var(--dim)">No record of a client confirmation on this row.</div>';
  if(n.result === 'sent') return '<div style="' + st + 'color:var(--green)">&#10003; Client emailed at ' + esc(n.to || '')
    + (n.source === 'typed' ? ' <span style="color:var(--amber-ink)">(typed by ' + esc(String(n.chosen_by||'agent').split('@')[0]) + ', not from the record)</span>' : '') + '</div>';
  if(n.result === 'pending') return '<div style="' + st + 'color:var(--amber-ink)">Client email to ' + esc(n.to || '') + ' — result not recorded. Check with Saif.</div>';
  if(n.result === 'failed') return '<div style="' + st + 'color:var(--red-ink)">&#10007; Client email ' + (n.to ? 'to ' + esc(n.to) + ' ' : '') + 'FAILED' + (n.detail ? ' — ' + esc(n.detail) : '') + '. The client has not been told.</div>';
  if(n.result === 'skipped') return '<div style="' + st + 'color:var(--red-ink)">&#10007; Client NOT told' + (n.detail || n.skip_reason ? ' — ' + esc(n.detail || n.skip_reason) : '') + '</div>';
  return '<div style="' + st + 'color:var(--mute)">Client confirmation: ' + esc(n.detail || n.result || '') + '</div>';
}
const SENDBACK_LABELS = { receipt_missing: 'Receipt missing', receipt_unreadable: 'Receipt unreadable', wrong_amount: 'Wrong amount',
  wrong_carrier: 'Wrong carrier', need_photos: 'Need photos of documents', other: 'Needs a fix' };
function sendbackLabel(code){ return SENDBACK_LABELS[code] || 'Needs a fix'; }
function auditLineHtml(p){
  if(p.audit_status === 'invoice_open') return '<div style="font-size:11px;margin-top:3px;color:var(--mute)">No payment yet \u2014 the audit starts when the first payment comes in. Collect it from Charge \u2192 Pay this balance.</div>';
  /* Pacific, like every other stamp the agents read - the ISO slice printed UTC next to a "6 hr ago". */
  const t = ts => { try { return new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch(e){ return String(ts || '').slice(0, 16); } };
  const first = n => esc(String(n || '').split(' ')[0] || 'Tony');
  const sb = p.audit_sendback;
  if(p.audit_status === 'complete'){
    if(!p.audit_submitted_at) return '';
    return '<div style="font-size:11px;margin-top:3px;color:var(--green)">✓ Approved by ' + first(p.audit_completed_by_name)
      + (p.audit_completed_at ? ' · ' + esc(t(p.audit_completed_at)) : '')
      + (sb ? ' <span class="dim">(after a send-back)</span>' : '') + '</div>';
  }
  if(p.audit_status === 'ready_for_audit'){
    return '<div style="font-size:11px;margin-top:3px;color:var(--mute)">Submitted'
      + (p.audit_submitted_by_name ? ' by ' + first(p.audit_submitted_by_name) : '')
      + (p.audit_submitted_at ? ' · ' + esc(t(p.audit_submitted_at)) : '')
      + (sb ? ' · <b style="color:var(--amber-ink)">resubmitted after a send-back</b>' : '')
      + ' · nothing is earned until Tony approves</div>'
      + (sb && sb.reply ? '<div style="font-size:11.5px;margin-top:4px;color:var(--mute);padding-left:9px;border-left:2px solid var(--line)">Your reply: “' + esc(sb.reply) + '”</div>' : '');
  }
  if(sb){
    return '<div style="font-size:11.5px;margin-top:5px;color:var(--red-ink);padding-left:9px;border-left:2px solid var(--red-ink)">✗ Sent back by '
      + first(sb.by_name) + (sb.at ? ' · ' + esc(t(sb.at)) : '') + ' — <b>' + esc(sendbackLabel(sb.code)) + '</b>'
      + (sb.reason ? ': “' + esc(sb.reason) + '”' : '') + '</div>';
  }
  return '';
}
function refundable(p){
  const collected = Number(p.collected != null ? p.collected : p.amount) || 0;
  return +(collected - (Number(p.refunded) || 0)).toFixed(2);
}
function canRefundRow(c, p){
  if(!c) return false;
  /* An agent may always ASK — the sheet is the same, the button says "Send to Tony"
     and nothing moves. c.can_refund only decides whether the button refunds or
     requests. A payment already waiting on Tony offers neither. */
  if(p.refund_request) return false;
  if(p.refund_of) return false;                       // a refund is not refundable
  if(p.balance_of) return false;                      // the original carries the obligation
  /* NOT /link/ — it matched paylink_charge, a PAID link, and hid the button on the $1
     Saif paid through a link to test this. paylink_create is the only link kind that
     never collected money; the rest is audit_status. */
  if(/declin|fail|void/i.test(String(p.kind||'')) || p.kind === 'paylink_create') return false;
  if(['declined','link_sent','not_a_payment','void'].includes(p.audit_status)) return false;
  if(refundable(p) <= 0) return false;                // already fully refunded
  const owed = (p.total_owed != null && Number(p.total_owed) > Number(p.amount||0))
    ? Number(p.total_owed) : Number(p.amount||0);
  const collected = Number(p.collected != null ? p.collected : p.amount) || 0;
  if(collected + 0.004 < owed) return false;          // part paid: stage 4
  return true;
}
function openBalances(cache){
  const pays = (cache && cache.payments) || [];
  return pays.filter(p => {
    if(!p.total_owed) return false;
    const got = p.collected != null ? Number(p.collected) : Number(p.amount || 0);
    return Number(p.total_owed) > got + 0.005;
  }).map(p => {
    const got = p.collected != null ? Number(p.collected) : Number(p.amount || 0);
    return { id: p.id, ts: p.ts, owed: Number(p.total_owed), got, left: +(Number(p.total_owed) - got).toFixed(2) };
  });
}
function payHistoryHtml(c, opts){
  opts = Object.assign({ me: null, clientNo: null, actions: true }, opts || {});
  const pays = c.payments || [];
  const docs = c.documents || [];
  if(!pays.length && !docs.length) return '<div class="paycard"><div class="dim" style="font-size:11px">No payments recorded for this client yet.</div></div>';

  const byPay = {};
  docs.forEach(d => { const k = d.payment_id || '_client'; (byPay[k] = byPay[k] || []).push(d); });

  let h = '<div class="paycard"><div style="font-size:10px;color:var(--mute);letter-spacing:.06em;margin:14px 0 8px">PAYMENTS &amp; DOCUMENTS'
    + (c.producer_name ? ' <span style="text-transform:none;letter-spacing:0;color:var(--mute)">· producer ' + esc(c.producer_name) + '</span>' : '')
    + '</div>';
  h += pays.map(p => {
    /* Two different questions, and they used to be conflated into one broken test
       against a display name. Who EARNS it decides who finishes the audit; who
       TOOK it decides who may help with paperwork. */
    const mine = (p.commission_to === opts.me);
    const iCharged = (p.charged_by_email === opts.me);
    /* Admin sees the correction links on ANY payment, because the server already lets
       admin act on any payment — move_client, reassign_commission and link_balance all
       test `isAdmin || iCharged || iOwn`. Without this the card offered nothing to the
       one person meant to be able to fix anything. Comes from the server (portal_client
       returns is_admin); an identity compared in the browser is only a claim. */
    const iAdmin = !!c.is_admin;
    const canCorrect = opts.actions && (mine || iCharged || iAdmin);
    const dl = byPay[p.id] || [];
    const complete = p.audit_status === 'complete';
    /* A balance payment pays down an earlier charge and carries NO audit of its own —
       the original holds the carrier cost and the single fee. Without this the card
       showed it as "needs proof" and offered the full audit, which would write a
       SECOND fee onto the balance row; the Trust tab reads fee_amount with no
       audit_status filter, so that fee would count as Speedy profit. `portal_home` has
       always skipped these rows; the card could not, because balance_of was never
       returned. Documents stay available — a cash balance may well have a receipt. */
    const isBal = !!p.balance_of;
    const parent = isBal ? pays.find(q => q.id === p.balance_of) : null;
    /* Is there an EARLIER payment on this client still showing a balance owed, other
       than this row itself? Same helper the charge sheet uses, so the card and the
       "Pay this balance" box can never disagree about what is outstanding. */
    const otherOpenBalance = openBalances(c).some(b => b.id !== p.id);
    const hasCarrier = dl.some(d => d.kind === 'proof' || docType(d) === 'carrier_receipt' || String(d.doc_type || '').endsWith('_no_payment'));
    /* A REFUND ROW, and a row that has BEEN refunded, are two different things and both
       have to be legible. Without the second one the card would show a $187.00 payment
       at full value with a −$187.00 line somewhere below it and nothing joining them —
       exactly how the balance payments read before item 76, when Saif had to ask what
       the $34 line was. */
    const isRefund = !!p.refund_of;
    const refundedOff = Number(p.refunded) || 0;
    /* A pay link that was only SENT is not a payment. It showed as "needs proof" with
       "Add documents to help" and "Sammy still confirms the carrier cost" — three
       things that are only true of money that arrived. Seen on ZZTEST, Sep 11. */
    const isLink = p.kind === 'paylink_create' || p.audit_status === 'link_sent';
    /* OPEN INVOICE (Sep 14): what the client owes, recorded without a payment. Nothing
       to audit until money arrives; "Pay this balance" on the charge sheet collects it. */
    const isInvoice = p.kind === 'invoice_open';
    const invoiceOpen = isInvoice && p.audit_status === 'invoice_open';
    /* THE REVIEW (Sep 12). "waiting for Tony" is submitted and not yet approved: the
       agent may still edit it, but nothing is earned. "sent back" is the one state the
       agent MUST act on, and it carries the approver's reason on the row for good. */
    const waiting = p.audit_status === 'ready_for_audit';
    const sentBack = !complete && !waiting && !!p.audit_sendback;
    const refParent = isRefund ? pays.find(q => q.id === p.refund_of) : null;
    return '<div style="background:var(--field);border:1px solid ' + (isRefund ? 'rgba(224,49,49,.35)' : 'var(--line)')
      + ';border-radius:10px;padding:10px 11px;margin-bottom:7px">'
      + '<div class="row" style="align-items:flex-start">'
      + '<div><b style="font-size:14px' + (isRefund ? ';color:var(--red-ink)' : '') + '">' + (isInvoice ? 'Open invoice ' + money(p.total_owed) : money(p.amount)) + '</b>'
      /* Only ever true on ZZTEST for an admin (item 84). Said in amber on the row so a
         test dollar is never read as a real one. */
      + (p.is_test ? ' <span class="beta" style="background:var(--amber)">TEST</span>' : '')
      /* PRINT THE ABSOLUTES. This said "$130.50 · $20.00 still owed" and never mentioned
         the $184.50 the client actually owed — the same gap Saif found on the Console
         row the same morning, which balanceCell now fixes there. Fixing one reader and
         leaving the other is how two screens end up disagreeing about one number. */
      + ((p.total_owed && p.total_owed > (p.collected || p.amount))
          ? '<span style="color:var(--amber-ink);font-size:11.5px"> · ' + (invoiceOpen ? 'nothing collected yet' : '$'
            + Number(p.collected || p.amount).toFixed(2) + ' of $' + Number(p.total_owed).toFixed(2))
            + ' · $' + (p.total_owed - (p.collected || p.amount)).toFixed(2) + ' still owed</span>'
          : (isInvoice && p.total_owed ? '<span style="color:var(--green);font-size:11.5px"> · collected in full</span>' : ''))
      + ' <span class="dim" style="font-size:11.5px">' + esc(p.purpose || '') + '</span></div>'
      + '<span style="font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:7px;'
      /* GREY, not blue. The card's colour language is amber = needs attention, green =
         done, and BLUE = clickable (change, wrong client, every document chip). A blue
         chip reads as a button, and a balance payment needs nothing done to it — which
         is the whole point of item 76. Neutral is the honest colour. */
      /* Refund states come FIRST. A refund row carries audit_status 'complete' — that is
         what makes the commission engine reverse it — so without this it would wear an
         "audited" chip, which is true of the audit and badly misleading about the row. */
      + (isRefund ? 'background:rgba(224,49,49,.15);color:var(--red-ink)'
        : p.refund_request ? 'background:rgba(245,166,35,.15);color:var(--amber-ink)'
        : refundedOff > 0 ? 'background:rgba(224,49,49,.15);color:var(--red-ink)'
        : isLink ? 'background:rgba(143,154,196,.14);color:var(--mute)'
        : invoiceOpen ? 'background:rgba(245,166,35,.15);color:var(--amber-ink)'
        : isBal ? 'background:rgba(143,154,196,.14);color:var(--mute)'
               : complete ? 'background:rgba(47,191,113,.15);color:var(--green)'
               : sentBack ? 'background:rgba(224,49,49,.15);color:var(--red-ink)'
               : waiting ? 'background:rgba(143,154,196,.14);color:var(--mute)'
                          : 'background:rgba(245,166,35,.15);color:var(--amber-ink)')
      + '">' + (isRefund ? 'refund'
        : p.refund_request ? 'refund requested'
        : refundedOff > 0 ? (refundedOff + 0.004 >= Number(p.collected != null ? p.collected : p.amount) ? 'refunded' : 'part refunded')
        : isLink ? 'link sent · not paid'
        : invoiceOpen ? 'open invoice · nothing collected'
        : isBal ? 'balance payment' : complete ? 'audited' : sentBack ? 'sent back' : waiting ? 'waiting for Tony' : 'needs proof') + '</span></div>'
      + '<div class="dim" style="font-size:11px;margin-top:2px">'
      + esc(String(p.ts||'').slice(0,10))
      + (p.ref ? ' · ' + esc(p.ref) : '')
      + (p.charged_by ? ' · charged by ' + esc(p.charged_by.split(' ')[0]) : '')
      + (p.carrier_name ? ' · carrier ' + esc(p.carrier_name)
          + (p.service_cost != null ? ' ' + money(p.service_cost) : '') : '')
      /* money(), not an inline '$' + toFixed — which printed "Speedy kept $-75.00" on a
         refund row. The eighth place this week that formatted a figure by hand instead
         of through the one function that knows where the minus sign goes.
         And "kept" is wrong for a refund: nothing was kept, it was given back. */
      + (p.fee_amount != null
          ? (isRefund ? ' · Speedy’s ' + money(Math.abs(Number(p.fee_amount))) + ' reversed'
                      : ' · Speedy kept ' + money(p.fee_amount))
          : '')
      + '</div>'
      + '<div class="dim" style="font-size:11px;margin-top:3px">Commission to <b style="color:var(--ink)">'
      + esc(p.commission_to_name || 'unassigned') + '</b>'
      + (canCorrect
          ? ' · <span style="color:var(--blue-l);cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();reassignPayment(\'' + p.id + '\',\'' + esc(p.commission_to||'') + '\')">change</span>'
            + ' · <span style="color:var(--mute);cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();moveClient(\'' + p.id + '\',' + ((c.client && c.client.client_no) || opts.clientNo || 0) + ',' + Number(p.amount||0) + ')">wrong client</span>'
            /* Offered only when there is something to link TO — an earlier payment on
               this client still showing a balance owed — and only on a row that is not
               already a balance payment and not audited. The server re-checks all of
               it; this just avoids showing a link that can only fail. */
            + ((!isBal && !complete && otherOpenBalance)
                ? ' · <span style="color:var(--mute);cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();linkBalance(\'' + p.id + '\',' + Number(p.amount||0) + ')">pays down a balance</span>'
                : '')
            /* THE CLIENT STILL OWES MORE (Sep 14): a payment taken as paid in full that
               turns out to be part of a bigger sale. Not on balance rows, refunds,
               links, invoices or approved payments. */
            + ((!isBal && !complete && !isRefund && !isLink && !isInvoice)
                ? ' · <span style="color:var(--mute);cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();setTotalOwed(\'' + p.id + '\',' + Number(p.collected != null ? p.collected : (p.amount || 0)) + ',' + Number(p.total_owed || 0) + ')">' + (p.total_owed && p.total_owed > (p.collected || p.amount) ? 'change the total owed' : 'client still owes more') + '</span>'
                : '')
            /* The way back out, while nothing has been audited. */
            + (isBal
                ? ' · <span style="color:var(--mute);cursor:pointer;text-decoration:underline" onclick="event.stopPropagation();unlinkBalance(\'' + p.id + '\',' + Number(p.amount||0) + ')">not a balance payment</span>'
                : '')
          : '')
      + '</div>'
      /* Says which charge it pays down, so a $34 line beside a $130.50 line is not a
         mystery second sale. The original may be outside this client's 50-row window,
         in which case the id alone would mean nothing — so say only what is known. */
      /* WHAT THIS REFUND UNDID, and what it meant. The reason is not decoration: it is
         what decided whether the client still owes the money, so it belongs on the row
         and not only in an event nobody opens. */
      + (isRefund
          ? '<div style="font-size:11px;margin-top:3px;color:var(--mute)">Refunds the '
            + (refParent ? money(refParent.amount) + ' payment from ' + esc(String(refParent.ts||'').slice(0,10))
                         : 'earlier payment on this client')
            + (p.refund_reason ? ' · ' + esc(String(p.refund_reason).replace(/_/g, ' ')) : '')
            + (p.refund_carrier ? ' · carrier money '
                + (p.refund_carrier === 'yes' ? 'returned'
                   : p.refund_carrier === 'no' ? '<b style="color:var(--red-ink)">not returned — Speedy absorbed it</b>'
                   : 'not back yet') : '')
            + '</div>'
            + (p.refund_note ? '<div style="font-size:11.5px;color:var(--mute);margin-top:5px;padding-left:9px;'
                + 'border-left:2px solid var(--line)">' + esc(p.refund_note) + '</div>' : '')
          : '')
      /* WAS THE CLIENT TOLD — on every payment and every refund, never blank. Charges
         have recorded this since July and shown it nowhere: 19 of the last 60 said
         "no client email on file" behind a green success screen. A row with no record
         at all says so, because "nothing recorded" is different from "not sent". */
      + (isLink || invoiceOpen ? '' : noticeLineHtml(p.client_notice))   // nothing was charged on an open invoice: nothing to have told the client
      + (isLink || isBal || isRefund ? '' : auditLineHtml(p))
      /* A REFUND REQUEST WAITING ON TONY. Shown on the payment, with who asked and when,
         and the Refund button is withheld for everyone until he decides. */
      + (p.refund_request
          ? '<div style="font-size:11px;margin-top:3px;color:var(--amber-ink)">Refund of ' + money(p.refund_request.amount)
            + ' requested by ' + esc(String(p.refund_request.requested_by_name || p.refund_request.requested_by).split(' ')[0])
            + ' on ' + esc(String(p.refund_request.requested_at || '').slice(0, 10))
            + ' — <b>waiting for Tony</b></div>'
          : '')
      /* And on the payment itself: how much of it has gone back. */
      + (!isRefund && refundedOff > 0
          ? '<div style="font-size:11px;margin-top:3px;color:var(--red-ink)">'
            + money(-refundedOff) + ' refunded — the original charge stays on file, it cannot be withdrawn.</div>'
          : '')
      + (isBal
          ? '<div class="dim" style="font-size:11px;margin-top:3px;color:var(--mute)">'
            + 'Pays down the '
            + (parent ? money(parent.amount) + ' payment from '
                        + esc(String(parent.ts || '').slice(0, 10))
                      : 'earlier charge on this client')
            + ' · that one carries the audit</div>'
          : '')
      + (dl.length
          ? '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px">'
            + dl.map(d => '<span class="docchip" id="pd' + d.id + '" onclick="openPortalDoc(\'' + d.id + '\')">'
                + esc(docTypeLabel(docType(d))) + (d.bytes ? ' · ' + bytesLabel(d.bytes) : '')
                + (d.uploaded_by ? ' · ' + esc(uploaderShort(d.uploaded_by)) : '') + '</span>').join('')
            + '</div>'
          : (!complete && !isBal && !isLink && !invoiceOpen ? '<div class="dim" style="font-size:11px;margin-top:6px;color:var(--amber-ink)">No documents yet</div>' : ''))
      /* an open invoice has no payment to prove yet: no proof button until money arrives */
      + (opts.actions && !complete && !isBal && !isLink && !invoiceOpen && mine
          ? '<div onclick="finishAuditFor(\'' + p.id + '\',' + ((c.client && c.client.client_no) || opts.clientNo || 0) + ',' + Number(p.amount||0) + ')" '
            + 'style="margin-top:8px;text-align:center;background:' + (waiting ? 'transparent;border:1px solid var(--line);color:var(--blue-l)' : 'var(--amber);color:#2a1a00') + ';border-radius:9px;padding:8px;font-size:12.5px;font-weight:' + (waiting ? '600' : '700') + ';cursor:pointer">'
            + (sentBack ? 'Fix and resubmit' : waiting ? 'Edit before Tony reviews' : 'Add proof of payment') + '</div>'
          : '')
      /* Not the owner: documents only. save_carrier_leg is guarded server-side by
         mayTouchPayment, so offering the full audit here would let someone fill in a
         carrier cost and then be refused after the work. The owner still confirms
         the cost, and the line below says so - otherwise the amber badge staying put
         afterwards reads as broken. */
      + (opts.actions && !complete && !isBal && !isLink && !mine
          ? '<div onclick="addDocsFor(\'' + p.id + '\',' + ((c.client && c.client.client_no) || opts.clientNo || 0) + ',' + Number(p.amount||0) + ')" '
            + 'style="margin-top:8px;text-align:center;background:transparent;border:1px solid var(--line);color:var(--blue-l);border-radius:9px;padding:7px;font-size:12px;font-weight:600;cursor:pointer">Add documents to help</div>'
            + '<div class="dim" style="font-size:11px;text-align:center;margin-top:4px">'
            + esc((p.commission_to_name || 'The owner').split(' ')[0]) + ' still confirms the carrier cost</div>'
          : '')
      /* Audited payments used to be a dead end: the button above is gated on
         !complete, so an agent who noticed a missing document after submitting had
         no way back in. Open to ANY agent — adding paperwork is follow-up finishing,
         not a money change, and every chip above names its uploader. */
      /* Balance rows get this too, and ONLY this. addDocsFor is the documents-only
         screen — it never reaches the carrier audit, so a cash balance can still carry
         its receipt without anyone being able to write a fee onto the row. */
      /* The documents button and the Refund action share a row, so Refund is beside
         something familiar rather than buried in the four-link correction line above.
         Outlined and red: findable, not fat-fingerable, and it opens a sheet that asks
         four questions and shows every consequence before anything moves. Offered only
         when the SERVER said this person may refund (c.can_refund, from may()) and only
         where it can actually succeed — the server re-checks all of it regardless. */
      + (opts.actions && (complete || isBal || canRefundRow(c, p))
          ? '<div class="rowacts">'
            + ((complete || isBal)
                ? '<div class="actghost" onclick="event.stopPropagation();addDocsFor(\'' + p.id + '\',' + ((c.client && c.client.client_no) || opts.clientNo || 0) + ',' + Number(p.amount||0) + ')">'
                  + (isBal ? '+ Add documents' : '+ Add more documents') + '</div>'
                : '')
            + (canRefundRow(c, p)
                ? '<div class="actrefund" onclick="event.stopPropagation();openRefund(\'' + p.id + '\',' + ((c.client && c.client.client_no) || opts.clientNo || 0) + ')">'
                  + (c.can_refund ? 'Refund&hellip;' : 'Ask for a refund&hellip;') + '</div>'
                : '')
            + '</div>'
          : '')
      + '</div>';
  }).join('');

  const loose = byPay['_client'] || [];
  if(loose.length){
    h += '<div class="dim" style="font-size:11px;margin:8px 0 5px">Other documents on this client</div>'
      + '<div style="display:flex;flex-wrap:wrap;gap:5px">'
      + loose.map(d => '<span class="docchip" id="pd' + d.id + '" onclick="openPortalDoc(\'' + d.id + '\')">'
          + esc(docTypeLabel(docType(d))) + (d.bytes ? ' · ' + bytesLabel(d.bytes) : '') + '</span>').join('')
      + '</div>';
  }
  return h + '</div>';
}
async function openPortalDoc(id){
  const r = await api('portal_doc&id=' + encodeURIComponent(id));
  if(!r || !r.ok || (!r.file_b64 && !r.blob_url)){ alert('No file is stored for this document.'); return; }
  if(r.blob_url){ window.open(r.blob_url, '_blank'); return; }
  try{
    let b64 = r.file_b64; if(b64.startsWith('data:')) b64 = b64.split(',')[1] || '';
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: r.mime || 'application/pdf' }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }catch(e){ alert('That document could not be opened.'); }
}

window.PayCard = { html: payHistoryHtml, noticeLineHtml, auditLineHtml, sendbackLabel, docType, docTypeLabel, bytesLabel, uploaderShort, refundable, canRefundRow, openBalances, openDoc: openPortalDoc, money };
window.openPortalDoc = openPortalDoc;
})();
