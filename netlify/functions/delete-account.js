// Deletes the signed-in user's auth account. Cascades remove their profile,
// consultations, messages, and reminders (all reference auth.users on delete cascade).
// Requires: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
const https = require('https');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS'
};

function req(path, method, headers, payload) {
  const hostname = process.env.SUPABASE_URL.replace('https://', '');
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const token = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required' }) };

  const anon = process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!service) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Service role key not configured' }) };

  try {
    // 1. resolve the user id from their token
    const me = await req('/auth/v1/user', 'GET', { apikey: anon, Authorization: `Bearer ${token}` });
    const user = me.text ? JSON.parse(me.text) : null;
    if (!user || !user.id) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Could not verify your session' }) };

    // 2. delete the auth user with the service role (cascades to all their data)
    const del = await req(`/auth/v1/admin/users/${user.id}`, 'DELETE', { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' });
    if (del.status >= 400) return { statusCode: del.status, headers: CORS, body: JSON.stringify({ error: 'Failed to delete account' }) };

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
