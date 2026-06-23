const https = require('https');
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const { prompt, query } = JSON.parse(event.body);
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt' }) };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };

    const requestBody = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
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

    // Log the query for training data (fire-and-forget, won't fail the request)
    if (query) {
      try {
        const store = getStore('queries');
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await store.setJSON(key, { query, timestamp: new Date().toISOString() });
      } catch (e) {
        console.error('Log error:', e.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ content: text }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
