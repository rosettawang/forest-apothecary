const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
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
    'Authorization': `Bearer ${token}`,
    'Prefer': 'return=representation'
  };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
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

  const token = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required' }) };

  try {
    // GET — fetch all consultations for this user
    if (event.httpMethod === 'GET') {
      const res = await supabaseRequest('/rest/v1/consultations?select=*&order=created_at.desc', 'GET', null, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to fetch consultations' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res.body || []) };
    }

    // POST — save a new consultation
    if (event.httpMethod === 'POST') {
      const { concern, herbs, notes } = JSON.parse(event.body || '{}');
      if (!concern || !herbs) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'concern and herbs required' }) };
      const res = await supabaseRequest('/rest/v1/consultations', 'POST', { concern, herbs, notes: notes || null }, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to save consultation' }) };
      return { statusCode: 201, headers: CORS, body: JSON.stringify(Array.isArray(res.body) ? res.body[0] : res.body) };
    }

    // PATCH — mark a consultation as tried (or update notes)
    if (event.httpMethod === 'PATCH') {
      const { id, tried, notes } = JSON.parse(event.body || '{}');
      if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
      const updates = {};
      if (tried !== undefined) updates.tried = tried;
      if (notes !== undefined) updates.notes = notes;
      const res = await supabaseRequest(`/rest/v1/consultations?id=eq.${id}`, 'PATCH', updates, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to update consultation' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
