/* api/_inbox.js — shared by chat.js and rc-sms.js (an underscore file is not a
   Vercel function). One rule for "which client is this phone", in one place.

   resolveClient(s, phone10) -> { client_no, status }   status: confirmed | guess | none
     1. an agent 'link' row in phone_links wins  -> confirmed
     2. else HawkSoft's client_phone_index       -> guess, unless an agent rejected that pair
     3. else none
   Agents' decisions live in phone_links; the HawkSoft mirror is never written. */

/* agents.branch (the Staff page) holds the office NAME; conversations.branch holds the
   code the widget and rc_numbers use. One map, so "same branch" means the same thing
   for a person and for a thread. Accepts either form. */
const BRANCH_CODE = { 'moreno valley': 'mv', 'riverside van buren': 'vb', 'riverside magnolia': 'mg', 'lake elsinore': 'le', 'colton': 'co' };
export function branchCode(b) { const k = String(b || '').trim().toLowerCase().replace(/\s*[—-]\s*/g, ' '); if (['mv', 'vb', 'mg', 'le', 'co'].includes(k)) return k; return BRANCH_CODE[k] || null; }

export async function resolveClient(s, phone10) {
  if (!phone10) return { client_no: null, status: 'none' };
  const get = async path => { const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs }); const rows = await r.json().catch(() => null); return Array.isArray(rows) ? rows : []; };
  const links = await get(`phone_links?phone10=eq.${phone10}&select=client_no,kind&order=at.desc`);
  const link = links.find(x => x.kind === 'link');
  if (link) return { client_no: link.client_no, status: 'confirmed' };
  const idx = await get(`client_phone_index?phone10=eq.${phone10}&select=client_number&limit=1`);
  const guess = idx[0] ? idx[0].client_number : null;
  if (!guess) return { client_no: null, status: 'none' };
  if (links.some(x => x.kind === 'reject' && x.client_no === guess)) return { client_no: null, status: 'none' };
  return { client_no: guess, status: 'guess' };
}

/* the search behind "Find client": a client number, a phone, or name words (all must match) */
export async function findClients(s, q, limit = 8) {
  const get = async path => { const r = await fetch(`${s.base}/rest/v1/${path}`, { headers: s.hdrs }); const rows = await r.json().catch(() => null); return Array.isArray(rows) ? rows : []; };
  const raw = String(q || '').trim();
  if (!raw) return [];
  const digits = raw.replace(/\D/g, '');
  let clients = [];
  if (/^\d{1,7}$/.test(raw)) clients = await get(`clients?client_no=eq.${Number(raw)}&select=client_no,first_name,last_name,business_name,branch,phone,city&limit=1`);
  if (!clients.length && digits.length >= 7) {
    const p10 = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits.slice(-10);
    const idx = await get(`client_phone_index?phone10=eq.${p10}&select=client_number&limit=5`);
    const links = await get(`phone_links?phone10=eq.${p10}&kind=eq.link&select=client_no&limit=5`);
    const nos = [...new Set(links.map(x => x.client_no).concat(idx.map(x => x.client_number)))];
    if (nos.length) clients = await get(`clients?client_no=in.(${nos.join(',')})&select=client_no,first_name,last_name,business_name,branch,phone,city&limit=${limit}`);
  }
  if (!clients.length && !/^\d+$/.test(raw)) {
    const words = raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
    if (words.length) {
      const enc = encodeURIComponent;
      const and = words.map(w => `or(first_name.ilike.*${enc(w)}*,last_name.ilike.*${enc(w)}*,business_name.ilike.*${enc(w)}*)`).join(',');
      clients = await get(`clients?and=(${and})&select=client_no,first_name,last_name,business_name,branch,phone,city&order=last_name.asc&limit=${limit}`);
    }
  }
  if (!clients.length) return [];
  const nos = clients.map(c => c.client_no);
  const pols = await get(`policies?client_no=in.(${nos.join(',')})&select=client_no,carrier,policy_number,lob,expiration_date,status&order=expiration_date.desc&limit=${nos.length * 5}`);
  return clients.map(c => {
    const p = pols.find(x => x.client_no === c.client_no);
    return { client_no: c.client_no, name: c.business_name || [c.first_name, c.last_name].filter(Boolean).join(' '), branch: c.branch || null, phone: c.phone || null, city: c.city || null,
      policy: p ? { carrier: p.carrier, number: p.policy_number, lob: p.lob, expires: p.expiration_date, status: p.status } : null };
  });
}
