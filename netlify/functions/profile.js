const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function supabase(path, method, body, token, extraPrefer) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');
  const hostname = url.replace('https://', '');
  const payload = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': `Bearer ${token}`,
    'Prefer': extraPrefer ? `return=representation,${extraPrefer}` : 'return=representation'
  };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch (e) { reject(e); } });
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
    if (event.httpMethod === 'GET') {
      const res = await supabase('/rest/v1/profiles?select=*', 'GET', null, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to fetch profile' }) };
      const row = Array.isArray(res.body) && res.body.length ? res.body[0] : null;
      return { statusCode: 200, headers: CORS, body: JSON.stringify(row || { phone: null, sms_opt_in: false }) };
    }

    // POST — upsert the user's profile (phone, opt-in, meds, history). id defaults to auth.uid().
    if (event.httpMethod === 'POST') {
      const { phone, sms_opt_in, medications, medical_history } = JSON.parse(event.body || '{}');
      const row = {};
      if (phone !== undefined) row.phone = phone;
      if (sms_opt_in !== undefined) row.sms_opt_in = sms_opt_in;
      if (medications !== undefined) row.medications = medications;
      if (medical_history !== undefined) row.medical_history = medical_history;
      const res = await supabase('/rest/v1/profiles?on_conflict=id', 'POST', row, token, 'resolution=merge-duplicates');
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to save profile' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(Array.isArray(res.body) ? res.body[0] : res.body) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
