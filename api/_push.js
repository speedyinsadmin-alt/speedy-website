/* api/_push.js — web push to agents' devices (Sep 18). Shared by chat.js and rc-sms.js;
   an underscore file is not a Vercel function.

   One row per device in push_subscriptions (the agent turned it on in the Alerts sheet).
   pushTo() sends one payload to every device of the given agents, skipping anyone whose
   agent_duty.muted_until is in the future. A 404/410 from the push service means the
   device unsubscribed: the row is deleted. Other failures count on the row.

   Nothing here throws: a push that cannot go out must never stop the text, the claim
   or the reply that triggered it. Without VAPID keys in the environment every call is a
   quiet no-op and the SMS chain carries on as before.

   Payload (the service worker in admin/sw.js reads it):
     { type: 'alert'|'msg'|'whisper'|'escalation', tag, title, body, url, id, claim? }
     { type: 'withdraw', tag }            closes that notification on the device */
const enc = encodeURIComponent;
export const pushReady = () => !!(process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE);

/* the sender is swappable so the harness can capture payloads without the library */
let sender = null;
async function getSender() {
  if (globalThis.__speedyPushSender) return globalThis.__speedyPushSender;
  if (sender) return sender;
  const wp = (await import('web-push')).default;
  wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@speedyins.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  sender = async (sub, body, opts) => wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, opts);
  return sender;
}

async function sbGet(s, path) { const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs }); const rows = await r.json().catch(() => null); return Array.isArray(rows) ? rows : []; }

/* who among these is muted right now */
export async function mutedSet(s, emails) {
  if (!emails.length) return new Set();
  const rows = await sbGet(s, `agent_duty?agent_email=in.(${emails.map(enc).join(',')})&select=agent_email,muted_until`);
  const now = Date.now();
  return new Set(rows.filter(r => r.muted_until && new Date(r.muted_until).getTime() > now).map(r => r.agent_email));
}

export async function pushTo(s, emails, payload, opts = {}) {
  const out = { sent: 0, failed: 0, skipped: 0, devices: 0 };
  try {
    const list = [...new Set((emails || []).filter(Boolean))];
    if (!list.length || !s) return out;
    if (!pushReady() && !globalThis.__speedyPushSender) return out;
    const muted = opts.ignoreMute ? new Set() : await mutedSet(s, list);
    const targets = list.filter(e => !muted.has(e));
    out.skipped = list.length - targets.length;
    if (!targets.length) return out;
    const subs = await sbGet(s, `push_subscriptions?agent_email=in.(${targets.map(enc).join(',')})&select=id,agent_email,endpoint,p256dh,auth,fails`);
    out.devices = subs.length;
    if (!subs.length) return out;
    const send = await getSender();
    const body = JSON.stringify(payload);
    await Promise.all(subs.map(async sub => {
      try {
        await send(sub, body, { TTL: opts.ttl || 600, urgency: opts.urgency || 'high', topic: payload.tag ? String(payload.tag).slice(0, 32) : undefined });
        out.sent++;
        if (sub.fails) await fetch(`${s.base}/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify({ fails: 0, last_ok_at: new Date().toISOString() }) });
      } catch (e) {
        out.failed++;
        const code = Number(e && e.statusCode);
        if (code === 404 || code === 410) await fetch(`${s.base}/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE', headers: s.hdrs });
        else await fetch(`${s.base}/rest/v1/push_subscriptions?id=eq.${sub.id}`, { method: 'PATCH', headers: { ...s.hdrs, Prefer: 'return=minimal' }, body: JSON.stringify({ fails: (sub.fails || 0) + 1 }) });
      }
    }));
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

/* close a notification everywhere it was shown (a chat got claimed by someone else) */
export const withdraw = (s, emails, tag) => pushTo(s, emails, { type: 'withdraw', tag }, { ttl: 300, urgency: 'normal', ignoreMute: true });
