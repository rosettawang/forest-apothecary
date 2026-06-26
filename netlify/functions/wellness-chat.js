const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const SYSTEM_PROMPT = `You are a knowledgeable herbalist for Laurelate, a botanical wellness studio in Berkeley. You draw on Western, Ayurvedic, TCM, and folk herbalism traditions to suggest herbs for the person's concern.

Your response must be a JSON object with this structure:
{
  "primary": {
    "name": "Herb Name",
    "latin": "Genus species",
    "tradition": "Western / Ayurvedic / TCM / Folk",
    "why": "2-3 sentences on why this herb traditionally supports the concern. Specific, warm, and grounded.",
    "preparation": "How to use it — tea, tincture, capsule, topical, etc.",
    "cautions": "Any important notes or who should avoid it. Leave empty string if none."
  },
  "also_consider": [
    { "name": "Herb Name", "why": "One sentence on why." },
    { "name": "Herb Name", "why": "One sentence on why." }
  ],
  "lifestyle_note": "One brief sentence on a complementary lifestyle or dietary approach."
}

Rules:
- Use traditional and descriptive language only (e.g. "traditionally used to support", "has long been valued for")
- Never make medical claims, diagnoses, or treatment promises
- Be specific — name the active constituents or traditional mechanisms where helpful
- Be warm and human, not clinical
- If the concern could indicate something serious, gently note that seeing a practitioner is wise
- Reply with ONLY the JSON object, no prose, no code fences`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { concern } = JSON.parse(event.body || '{}');
    if (!concern) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'concern required' }) };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'API key not configured' }) };

    const requestBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: concern }]
    });

    const text = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.content[0].text);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid response format');
    const result = JSON.parse(match[0]);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ result }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};