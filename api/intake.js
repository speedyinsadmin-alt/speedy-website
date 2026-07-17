// /api/intake — AI document extraction for smart intake.
// POST only. Requires x-admin-key header (ADMIN_API_KEY).
// action: extract — body { data: base64, fileExt: pdf|jpg|jpeg|png }
// Sends the document to the Anthropic API and returns structured fields.
// PII note: document content is processed in transit for extraction; nothing is stored.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const KEY = process.env.ADMIN_API_KEY;
  if (!KEY) return res.status(500).json({ ok: false, error: 'ADMIN_API_KEY env var not set' });
  if ((req.headers['x-admin-key'] || '') !== KEY) {
    return res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
  }

  const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY env var not set in Vercel' });

  const { action } = req.body || {};
  if (action !== 'extract') return res.status(400).json({ ok: false, error: 'Unknown action' });

  const b = req.body || {};
  const ext = String(b.fileExt || '').toLowerCase().replace(/^\./, '');
  if (!b.data) return res.status(400).json({ ok: false, error: 'File data missing' });
  const isPdf = ext === 'pdf';
  const isImg = ['jpg', 'jpeg', 'png'].includes(ext);
  if (!isPdf && !isImg) return res.status(400).json({ ok: false, error: 'Extraction supports pdf, jpg, or png' });

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.data } }
    : { type: 'image', source: { type: 'base64', media_type: ext === 'png' ? 'image/png' : 'image/jpeg', data: b.data } };

  const prompt = `You are an insurance document extraction engine for an independent insurance agency.
Read the attached document (declarations page, ID card, application, or driver license) and extract the fields below.

Respond with ONLY a JSON object — no markdown fences, no commentary. Use null for anything not present. Format dates as MM/DD/YYYY. Premium as a plain number string with 2 decimals, no $ or commas.

{
  "docType": "dec page | id card | application | driver license | other",
  "insured": { "firstName": "", "lastName": "", "phone": "", "email": "", "address1": "", "city": "", "state": "", "zip": "", "dob": "" },
  "policy": { "policyNumber": "", "carrier": "", "lob": "", "effectiveDate": "", "expirationDate": "", "premium": "", "applicationType": "Personal or Commercial" },
  "vehicle": { "description": "year make model", "vin": "" },
  "coverages": "compact one-line summary like: BI 25/50 | PD 25k | UM 25/50 | Comp/Coll $500 ded",
  "notes": "anything unusual an agent should know, one short line, or null"
}`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
    }),
  });

  const raw = await r.text();
  if (!r.ok) {
    return res.status(200).json({ ok: false, httpStatus: r.status, error: 'AI API error', detail: raw.slice(0, 300) });
  }
  let fields = null;
  try {
    const data = JSON.parse(raw);
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    fields = JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Could not parse extraction result' });
  }
  return res.status(200).json({ ok: true, fields });
}
