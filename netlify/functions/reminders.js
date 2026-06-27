const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
};

function supabase(path, method, body, token) {
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
      // upcoming (not yet sent) reminders, soonest first
      const res = await supabase('/rest/v1/reminders?select=*&sent=eq.false&order=send_at.asc', 'GET', null, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to fetch reminders' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(res.body || []) };
    }

    if (event.httpMethod === 'POST') {
      const { send_at, message, repeat, consultation_id } = JSON.parse(event.body || '{}');
      if (!send_at) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'send_at required' }) };
      if (!message || !message.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'message required' }) };
      const when = new Date(send_at);
      if (isNaN(when.getTime())) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid send_at' }) };
      const row = {
        send_at: when.toISOString(),
        message: message.trim().slice(0, 320),
        repeat: (repeat === 'daily') ? 'daily' : 'none'
      };
      if (consultation_id) row.consultation_id = consultation_id;
      const res = await supabase('/rest/v1/reminders', 'POST', row, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to create reminder' }) };
      return { statusCode: 201, headers: CORS, body: JSON.stringify(Array.isArray(res.body) ? res.body[0] : res.body) };
    }

    if (event.httpMethod === 'DELETE') {
      const id = (event.queryStringParameters && event.queryStringParameters.id) || JSON.parse(event.body || '{}').id;
      if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id required' }) };
      const res = await supabase(`/rest/v1/reminders?id=eq.${id}`, 'DELETE', null, token);
      if (res.status >= 400) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: 'Failed to delete reminder' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
