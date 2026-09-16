/* Speedy Chat — visitor widget (stage 1, Sep 16 2026).
   Talks to /api/chat. State lives in localStorage['speedy_chat'] so a refresh or a
   second tab resumes the same conversation. Reads <script data-lang="en|es">.
   Flow: pick branch -> pick topic -> (optional) name + phone -> start
         live:    thread + input, polls every 3s; nobody claims -> the leave form
         offline: the leave form straight away (hours or nobody on duty)
   Nothing here decides who is on duty or whether we are open - the API does. */
(function () {
  var S = document.currentScript || document.querySelector('script[src*="chat.js"]');
  var LANG = (S && S.dataset.lang === 'es') ? 'es' : 'en';
  var API = '/api/chat', KEY = 'speedy_chat', POLL_MS = 3000;

  var BR = [
    ['mv', 'Moreno Valley', '(951) 472-0927'], ['vb', 'Riverside — Van Buren', '(951) 695-1500'], ['mg', 'Riverside — Magnolia', '(951) 977-9400'],
    ['le', 'Lake Elsinore', '(951) 579-4095'], ['co', 'Colton', '(909) 587-6001'],
  ];
  var T = {
    en: { tip: 'Talk to an Agent', title: 'Speedy Insurance', subLive: 'We reply in about a minute · Hablamos Español', subOff: 'Closed now', subWait: 'Connecting you to an agent…', subWith: 'Chatting with ',
      branch: 'Branch:', change: 'Change', pick: 'Which branch is closest to you?', topics: ['Get a quote', 'SR-22', 'DMV services', 'Make a payment', 'Tow / commercial', 'Something else'],
      ask: 'So an agent can text you if we get cut off — what\'s your name and best number?', name: 'Your name', phone: '(951) 555-0100', startBtn: 'Start chat', skip: 'Skip for now',
      offMsg: function (b, at) { return 'We\'re closed right now — ' + b + ' opens ' + at + '. Leave your number and what you need; an agent texts you first thing.'; },
      dutyMsg: 'All our agents are with customers right now. Leave your number and what you need — an agent texts you shortly.',
      missMsg: 'This is taking longer than usual. Leave your number and we\'ll text you as soon as an agent is free.',
      what: 'What do you need?', sendBtn: 'Send — we\'ll text you', sentTitle: 'Got it — we\'ll text you.', sent: 'Your message is with our team. Need it faster? Call (951) 695-1500.',
      urgent: 'Urgent? Moreno Valley is open Sundays 10–5 · (951) 472-0927', foot: 'No bots selling anything — a licensed agent answers.', footOff: 'Your message becomes a lead in our system — nothing gets lost.',
      joined: ' joined the chat', closed: 'This chat has ended. Start a new one any time.', type: 'Type a message…', you: 'You', needPhone: 'Please leave a phone number or email.', err: 'Something went wrong — please call (951) 695-1500.', newChat: 'New chat' },
    es: { tip: 'Hable con un agente', title: 'Speedy Insurance', subLive: 'Respondemos en un minuto · Hablamos Español', subOff: 'Cerrado ahora', subWait: 'Conectándolo con un agente…', subWith: 'Chateando con ',
      branch: 'Sucursal:', change: 'Cambiar', pick: '¿Qué sucursal le queda más cerca?', topics: ['Cotización', 'SR-22', 'Servicios DMV', 'Hacer un pago', 'Grúas / comercial', 'Otra cosa'],
      ask: 'Para que un agente le pueda escribir si se corta — ¿su nombre y mejor número?', name: 'Su nombre', phone: '(951) 555-0100', startBtn: 'Iniciar chat', skip: 'Omitir por ahora',
      offMsg: function (b, at) { return 'Estamos cerrados — ' + b + ' abre ' + at + '. Deje su número y lo que necesita; un agente le escribe a primera hora.'; },
      dutyMsg: 'Todos nuestros agentes están con clientes. Deje su número y lo que necesita — un agente le escribe en breve.',
      missMsg: 'Está tardando más de lo normal. Deje su número y le escribimos en cuanto un agente esté libre.',
      what: '¿Qué necesita?', sendBtn: 'Enviar — le escribimos', sentTitle: 'Listo — le escribimos.', sent: 'Su mensaje ya está con nuestro equipo. ¿Urge? Llame al (951) 695-1500.',
      urgent: '¿Urgente? Moreno Valley abre los domingos 10–5 · (951) 472-0927', foot: 'Sin bots — le responde un agente con licencia.', footOff: 'Su mensaje se convierte en un lead en nuestro sistema — nada se pierde.',
      joined: ' se unió al chat', closed: 'Este chat terminó. Inicie otro cuando guste.', type: 'Escriba un mensaje…', you: 'Usted', needPhone: 'Deje un teléfono o correo, por favor.', err: 'Algo salió mal — llame al (951) 695-1500.', newChat: 'Nuevo chat' },
  }[LANG];

  /* ---------- state ---------- */
  var st = load();
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode: the chat still works for this page */ } }
  function branchName(id) { var b = BR.filter(function (x) { return x[0] === id; })[0]; return b ? b[1] : ''; }

  /* ---------- DOM ---------- */
  var el = {};
  function h(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function build() {
    el.bubble = h('div', 'sc-bubble', '<span class="sc-tip">' + T.tip + '</span><span class="sc-dot"><i class="fas fa-comment"></i><span class="sc-n"></span></span>');
    el.panel = h('div', 'sc-panel');
    el.panel.innerHTML =
      '<div class="sc-head"><div class="sc-av"><i class="fas fa-headset"></i></div><div><div class="sc-title">' + T.title + '</div><div class="sc-sub"></div></div><button class="sc-close" aria-label="close"><i class="fas fa-times"></i></button></div>' +
      '<div class="sc-branch"><i class="fas fa-map-marker-alt" style="color:var(--red,#D42B2B)"></i> ' + T.branch + ' <b></b><button type="button">' + T.change + '</button></div>' +
      '<div class="sc-agent"><i class="fas fa-circle-check"></i> <span></span></div>' +
      '<div class="sc-body"></div>' +
      '<div class="sc-typing"><i></i><i></i><i></i></div>' +
      '<div class="sc-input"><input type="text" placeholder="' + T.type + '" maxlength="2000"><button type="button" aria-label="send"><i class="fas fa-paper-plane"></i></button></div>' +
      '<div class="sc-foot">' + T.foot + '</div>';
    document.body.appendChild(el.bubble); document.body.appendChild(el.panel);
    el.sub = el.panel.querySelector('.sc-sub'); el.branchBar = el.panel.querySelector('.sc-branch'); el.branchName = el.branchBar.querySelector('b');
    el.agent = el.panel.querySelector('.sc-agent'); el.body = el.panel.querySelector('.sc-body'); el.typing = el.panel.querySelector('.sc-typing');
    el.input = el.panel.querySelector('.sc-input'); el.text = el.input.querySelector('input'); el.foot = el.panel.querySelector('.sc-foot'); el.n = el.bubble.querySelector('.sc-n');
    el.bubble.addEventListener('click', toggle);
    el.panel.querySelector('.sc-close').addEventListener('click', toggle);
    el.branchBar.querySelector('button').addEventListener('click', function () { if (st.token && st.mode === 'live' && st.status !== 'closed') return; st.branch = null; save(); render(); });
    el.input.querySelector('button').addEventListener('click', sendTyped);
    el.text.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendTyped(); } });
  }
  function toggle() { var open = !el.panel.classList.contains('open'); el.panel.classList.toggle('open', open); if (open) { unread(0); render(); if (st.token) poll(); } }
  function unread(n) { st.unread = n; save(); el.n.textContent = n; el.n.classList.toggle('on', n > 0); }
  function scroll() { el.body.scrollTop = el.body.scrollHeight; }
  function msg(kind, body, meta) { var m = h('div', 'sc-msg ' + kind); m.appendChild(h('div', 'sc-bub')).textContent = body; if (meta) m.appendChild(h('div', 'sc-meta', meta)); el.body.appendChild(m); scroll(); return m; }
  function sys(text) { el.body.appendChild(h('div', 'sc-sys', text)); scroll(); }
  function hhmm(ts) { var d = ts ? new Date(ts) : new Date(); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  /* ---------- screens ---------- */
  function render() {
    el.panel.classList.toggle('offline', st.mode === 'offline' || st.status === 'missed' || st.status === 'closed');
    el.branchName.textContent = branchName(st.branch);
    el.branchBar.style.display = st.branch ? '' : 'none';
    el.agent.classList.remove('on'); el.input.classList.remove('on'); el.typing.classList.remove('on');
    el.body.innerHTML = '';
    if (!st.branch) return screenBranch();
    if (!st.token) return screenTopic();
    if (st.status === 'closed') return screenClosed();
    if (st.mode === 'offline' || st.status === 'missed') return screenLeave();
    return screenLive();
  }
  function screenBranch() {
    el.sub.textContent = T.subLive;
    msg('bot', T.pick);
    var g = h('div', 'sc-branches');
    BR.forEach(function (b) { var btn = h('button', '', b[1] + '<small>' + b[2] + '</small>'); btn.type = 'button'; btn.addEventListener('click', function () { st.branch = b[0]; save(); render(); }); g.appendChild(btn); });
    el.body.appendChild(g); el.foot.textContent = T.foot;
  }
  function screenTopic() {
    el.sub.textContent = T.subLive;
    msg('bot', 'Hi! 👋 ' + (LANG === 'es' ? 'Bienvenido a Speedy Insurance ' : 'Welcome to Speedy Insurance ') + branchName(st.branch) + '. ' + (LANG === 'es' ? '¿En qué le podemos ayudar hoy?' : 'What can we help you with today?'), 'Speedy · ' + (LANG === 'es' ? 'ahora' : 'now'));
    var q = h('div', 'sc-quick');
    T.topics.forEach(function (t) { var b = h('button', '', t); b.type = 'button'; b.addEventListener('click', function () { st.topic = t; q.remove(); msg('me', t, T.you); askContact(); }); q.appendChild(b); });
    el.body.appendChild(q); el.foot.textContent = T.foot;
  }
  function askContact() {
    msg('bot', T.ask);
    var f = h('div', 'sc-form');
    f.innerHTML = '<input name="name" placeholder="' + T.name + '" maxlength="80"><input name="phone" type="tel" placeholder="' + T.phone + '" maxlength="20"><button type="button" class="sc-btn"><i class="fas fa-comment"></i> ' + T.startBtn + '</button><button type="button" class="sc-skip">' + T.skip + '</button>';
    var go = function (skip) { start(skip ? '' : f.querySelector('[name=name]').value, skip ? '' : f.querySelector('[name=phone]').value, f); };
    f.querySelector('.sc-btn').addEventListener('click', function () { go(false); });
    f.querySelector('.sc-skip').addEventListener('click', function () { go(true); });
    el.body.appendChild(f); scroll();
  }
  function screenLive() {
    el.sub.textContent = st.agent ? T.subWith + st.agent.name : T.subWait;
    el.input.classList.add('on'); el.foot.textContent = T.foot;
    if (st.agent) { el.agent.classList.add('on'); el.agent.querySelector('span').innerHTML = '<b>' + esc(st.agent.name) + '</b>' + T.joined; }
    (st.msgs || []).forEach(paint);
    if (!st.agent) el.typing.classList.add('on');
  }
  function screenLeave(reasonText) {
    el.sub.textContent = st.mode === 'offline' && st.reason === 'closed' ? T.subOff + (st.opens_at ? ' · ' + (LANG === 'es' ? 'abre ' : 'opens ') + st.opens_at : '') : T.subLive;
    (st.msgs || []).forEach(paint);
    var text = reasonText || (st.status === 'missed' ? T.missMsg : (st.reason === 'closed' ? T.offMsg(branchName(st.branch), st.opens_at || '') : T.dutyMsg));
    msg('bot', text, 'Speedy');
    var f = h('div', 'sc-form');
    f.innerHTML = '<input name="name" placeholder="' + T.name + '" maxlength="80" value="' + esc(st.name || '') + '"><input name="phone" type="tel" placeholder="' + T.phone + '" maxlength="20" value="' + esc(st.phone || '') + '"><textarea name="message" placeholder="' + T.what + '" maxlength="2000"></textarea><button type="button" class="sc-btn"><i class="fas fa-paper-plane"></i> ' + T.sendBtn + '</button><div class="sc-err" style="display:none"></div>';
    f.querySelector('.sc-btn').addEventListener('click', function () { leave(f); });
    el.body.appendChild(f);
    if (st.reason === 'closed' && st.branch !== 'mv') el.body.appendChild(h('div', 'sc-note', T.urgent));
    el.foot.textContent = T.footOff; scroll();
  }
  function screenClosed() {
    el.sub.textContent = T.subLive; (st.msgs || []).forEach(paint);
    if (st.lead_id) { el.body.appendChild(h('div', 'sc-note', '<b>' + T.sentTitle + '</b><br>' + T.sent)); }
    else sys(T.closed);
    var b = h('button', 'sc-btn', T.newChat); b.type = 'button'; b.style.alignSelf = 'center'; b.addEventListener('click', function () { st = { branch: st.branch }; save(); render(); });
    el.body.appendChild(b); el.foot.textContent = T.foot;
  }
  function paint(m) { if (m.from === 'visitor') msg('me', m.body, T.you + ' · ' + hhmm(m.ts)); else msg('bot', m.body, (m.name || 'Speedy') + ' · ' + hhmm(m.ts)); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- API ---------- */
  function post(body) { return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }
  function start(name, phone, form) {
    var btn = form.querySelector('.sc-btn'); btn.disabled = true;
    st.name = name || ''; st.phone = phone || '';
    post({ action: 'start', branch: st.branch, lang: LANG, page: location.pathname, topic: st.topic, name: st.name, phone: st.phone, website: '' })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'start');
        st.token = j.token; st.id = j.id; st.mode = j.mode; st.reason = j.reason; st.opens_at = j.opens_at; st.status = j.mode === 'live' ? 'waiting' : 'offline';
        st.msgs = [{ from: 'system', body: j.greeting, ts: new Date().toISOString() }]; if (st.topic) st.msgs.push({ from: 'visitor', body: st.topic, ts: new Date().toISOString() });
        st.after = 0; save(); render(); if (st.mode === 'live') startPolling();
      })
      .catch(function () { btn.disabled = false; var e = h('div', 'sc-err', T.err); form.appendChild(e); });
  }
  function sendTyped() {
    var body = el.text.value.trim(); if (!body || !st.token) return;
    el.text.value = ''; var m = { from: 'visitor', body: body, ts: new Date().toISOString() }; st.msgs.push(m); save(); paint(m);
    post({ action: 'send', token: st.token, body: body }).then(function (j) { if (j && j.error === 'closed') { st.status = 'closed'; save(); render(); } }).catch(function () { sys(T.err); });
  }
  var timer = null;
  function startPolling() { if (timer) return; timer = setInterval(poll, POLL_MS); }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }
  function poll() {
    if (!st.token || st.status === 'closed' || st.mode === 'offline') return stopPolling();
    return post({ action: 'poll', token: st.token, after: st.after || 0 }).then(function (j) {
      if (!j.ok) return;
      var changed = false;
      (j.messages || []).forEach(function (m) {
        if (m.id <= (st.after || 0)) return; st.after = m.id; changed = true;
        if (m.from === 'visitor') return;                     /* ours are already painted */
        if (m.from === 'system' && (st.msgs || []).some(function (x) { return x.from === 'system' && x.body === m.body; })) return; /* the greeting we painted at start */
        st.msgs.push({ from: m.from, name: m.name, body: m.body, ts: m.ts }); changed = true;
        if (el.panel.classList.contains('open')) paint(m); else unread((st.unread || 0) + 1);
      });
      if (j.agent && (!st.agent || st.agent.name !== j.agent.name)) { st.agent = j.agent; changed = true; if (el.panel.classList.contains('open')) render(); }
      if (j.status !== st.status) { st.status = j.status; changed = true; if (j.status === 'missed' || j.status === 'closed') { stopPolling(); render(); if (!el.panel.classList.contains('open')) unread((st.unread || 0) + 1); } }
      if (changed) save();
    }).catch(function () { /* next tick */ });
  }
  function leave(form) {
    var name = form.querySelector('[name=name]').value.trim(), phone = form.querySelector('[name=phone]').value.trim(), message = form.querySelector('[name=message]').value.trim();
    var err = form.querySelector('.sc-err'); err.style.display = 'none';
    if (!phone.replace(/\D/g, '').length && !/@/.test(name)) { err.textContent = T.needPhone; err.style.display = 'block'; return; }
    var btn = form.querySelector('.sc-btn'); btn.disabled = true;
    post({ action: 'leave', token: st.token, name: name, phone: phone, message: message })
      .then(function (j) { if (!j.ok) throw new Error(j.error); st.lead_id = j.lead_id; st.status = 'closed'; st.name = name; st.phone = phone; if (message) st.msgs.push({ from: 'visitor', body: message, ts: new Date().toISOString() }); save(); stopPolling(); render(); })
      .catch(function () { btn.disabled = false; err.textContent = T.err; err.style.display = 'block'; });
  }

  /* ---------- boot ---------- */
  build();
  el.n.textContent = st.unread || 0; el.n.classList.toggle('on', (st.unread || 0) > 0);
  if (st.token && st.mode === 'live' && st.status !== 'closed') startPolling();
  window.SpeedyChat = { open: function () { if (!el.panel.classList.contains('open')) toggle(); }, state: function () { return st; } };
})();
