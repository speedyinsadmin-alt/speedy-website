/* Clover OAuth v2 (production) — authorizes the Speedy Payment Bridge app on our own
   merchants and stores tokens in Supabase clover_tokens (auto-refresh handled by the proxy).
   Visit /api/clover_oauth to start; Clover redirects back here with ?code=&merchant_id=. */

const APP_ID = process.env.CLOVER_APP_ID;
const APP_SECRET = process.env.CLOVER_APP_SECRET;
const REDIRECT = 'https://www.speedyins.com/api/clover_oauth';

async function saveTokens(merchantId, tok) {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return false;
  const row = {
    merchant_id: merchantId,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    access_expires: tok.access_token_expiration ? new Date(tok.access_token_expiration * 1000).toISOString() : null,
    refresh_expires: tok.refresh_token_expiration ? new Date(tok.refresh_token_expiration * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/clover_tokens`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  return r.status === 201 || r.status === 200 || r.status === 204;
}

const page = (title, body, ok) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;background:#0B1829;color:#F2F5FA;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#122036;border:1.5px solid ${ok ? '#1f9d55' : '#D42B2B'};border-radius:16px;padding:28px;max-width:420px;text-align:center}
b{font-style:italic}</style></head><body><div class="card">
<div style="font-size:20px;margin-bottom:6px"><b>SPEEDY</b> <b style="color:#D42B2B">INSURANCE</b></div>
<h2 style="margin:8px 0">${title}</h2><div style="opacity:.8;font-size:14px">${body}</div></div></body></html>`;

export default async function handler(req, res) {
  if (!APP_ID || !APP_SECRET) {
    return res.status(500).send(page('Not configured', 'CLOVER_APP_ID / CLOVER_APP_SECRET env vars are missing in Vercel.', false));
  }
  const { code, merchant_id } = req.query || {};

  // Step 1: no code — send the browser to Clover's authorize screen
  if (!code) {
    const u = `https://www.clover.com/oauth/v2/authorize?client_id=${encodeURIComponent(APP_ID)}&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    res.setHeader('Location', u);
    return res.status(302).end();
  }

  // Step 2: exchange the code for tokens
  try {
    const r = await fetch('https://api.clover.com/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, code }),
    });
    const tok = await r.json().catch(() => null);
    if (!r.ok || !tok || !tok.access_token) {
      return res.status(502).send(page('Authorization failed',
        `Clover returned HTTP ${r.status}. Close this tab and try again from /api/clover_oauth.`, false));
    }
    const mid = merchant_id || tok.merchant_id || 'UNKNOWN';
    const saved = await saveTokens(mid, tok);
    return res.status(200).send(page('Terminal authorization complete ✓',
      `Merchant <b>${mid}</b> is now authorized for the Speedy Payment Bridge.` +
      (saved ? ' Tokens stored securely.' : ' <b style="color:#D42B2B">Warning: token storage failed — check SUPABASE env vars.</b>') +
      '<br><br>You can close this tab.', saved));
  } catch (e) {
    return res.status(500).send(page('Error', String(e), false));
  }
}
