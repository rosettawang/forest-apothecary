const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function supabaseRequest(path, method, body, token) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');

  const hostname = url.replace('https://', '');
  const payload = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'apikey': key,
    'Content-Length': Buffer.byteLength(payload)
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { action, email, password } = JSON.parse(event.body || '{}');
    if (!email || !password) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Email and password required' }) };

    if (action === 'signup') {
      const res = await supabaseRequest('/auth/v1/signup', 'POST', { email, password });
      if (res.body.error) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: res.body.error.message || res.body.error }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ user: res.body.user, access_token: res.body.access_token, message: 'Check your email to confirm your account.' }) };
    }

    if (action === 'signin') {
      const res = await supabaseRequest('/auth/v1/token?grant_type=password', 'POST', { email, password });
      if (res.body.error) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: res.body.error_description || res.body.error }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ access_token: res.body.access_token, user: res.body.user }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown action. Use "signup" or "signin".' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};