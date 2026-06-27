// Scheduled function: sends due SMS check-ins via Twilio, then marks them sent.
// Runs on a schedule (see netlify.toml). Requires these env vars in Netlify:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (service role bypasses RLS to read all due reminders)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM   (your Twilio sending number, e.g. +14155550100)
const https = require('https');

function request(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function supabase(path, method, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostname = url.replace('https://', '');
  const payload = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Prefer': 'return=representation'
  };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
  return request({ hostname, path, method, headers }, payload)
    .then(r => ({ status: r.status, body: r.text ? JSON.parse(r.text) : null }));
}

function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const params = new URLSearchParams({ To: to, From: from, Body: body }).toString();
  const basic = Buffer.from(`${sid}:${auth}`).toString('base64');
  return request({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${sid}/Messages.json`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params)
    }
  }, params);
}

const run = async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TWILIO_ACCOUNT_SID) {
    return { statusCode: 200, body: 'Reminder sender not configured (missing service role or Twilio env vars).' };
  }
  try {
    const nowIso = new Date().toISOString();
    const due = await supabase(`/rest/v1/reminders?sent=eq.false&send_at=lte.${nowIso}&select=*`, 'GET');
    const rows = Array.isArray(due.body) ? due.body : [];
    if (!rows.length) return { statusCode: 200, body: 'No reminders due.' };

    // fetch phones for the users involved
    const userIds = [...new Set(rows.map(r => r.user_id))];
    const inList = userIds.map(id => `"${id}"`).join(',');
    const profs = await supabase(`/rest/v1/profiles?id=in.(${inList})&select=id,phone,sms_opt_in`, 'GET');
    const phoneByUser = {};
    (profs.body || []).forEach(p => { if (p.sms_opt_in && p.phone) phoneByUser[p.id] = p.phone; });

    let sent = 0, requeued = 0;
    for (const r of rows) {
      const phone = phoneByUser[r.user_id];
      if (phone) {
        const resp = await sendSms(phone, r.message);
        if (resp.status >= 200 && resp.status < 300) sent++;
      }
      if (r.repeat === 'daily') {
        // re-queue for the next day, keeping the same local clock time.
        // Advance from the scheduled time (not "now") and skip past any missed days.
        const next = new Date(r.send_at);
        const now = new Date();
        do { next.setUTCDate(next.getUTCDate() + 1); } while (next <= now);
        await supabase(`/rest/v1/reminders?id=eq.${r.id}`, 'PATCH', { send_at: next.toISOString(), sent: false });
        requeued++;
      } else {
        // one-shot: mark sent regardless so we don't retry forever on a bad number
        await supabase(`/rest/v1/reminders?id=eq.${r.id}`, 'PATCH', { sent: true });
      }
    }
    return { statusCode: 200, body: `Processed ${rows.length} reminders, sent ${sent}, requeued ${requeued}.` };
  } catch (err) {
    return { statusCode: 500, body: 'Reminder error: ' + err.message };
  }
};

// Scheduled via netlify.toml ([functions."send-reminders"] schedule = "*/15 * * * *").
// Exported as a plain handler so the cron registration lives in one place and the
// endpoint can also be invoked manually for testing.
exports.handler = run;
