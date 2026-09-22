// Records paid orders. This is the ONLY place an order is written.
//
// The success redirect is not proof of payment: a customer can close the
// tab before it fires, and anyone can open the thank-you URL directly.
// Trusting it would both lose real orders and invent fake ones.
//
// Signature verification is not optional either. An unverified webhook
// endpoint is a public URL that writes to the orders table, so anyone who
// finds it can post themselves a free order.

const crypto = require('crypto');
const https = require('https');

const TOLERANCE_SECONDS = 300;

function verify(rawBody, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map(p => p.split('=')).filter(p => p.length === 2)
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject replays of an old, genuinely-signed event.
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10)) > TOLERANCE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function supabaseInsert(table, row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars not configured');
  const payload = JSON.stringify(row);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.replace('https://', ''),
      path: `/rest/v1/${table}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        // Stripe retries on any non-2xx, so the same event can arrive twice.
        // stripe_session_id is unique and this turns the retry into a no-op.
        'Prefer': 'resolution=ignore-duplicates,return=minimal'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not set');
    return { statusCode: 500, body: 'Not configured' };
  }

  // Must be the exact bytes Stripe signed, so no JSON round-tripping.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  const header = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verify(rawBody, header, secret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch (e) { return { statusCode: 400, body: 'Bad payload' }; }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;

  // A session can complete while an async payment method is still pending.
  if (session.payment_status !== 'paid') {
    return { statusCode: 200, body: 'Not paid yet' };
  }

  try {
    await supabaseInsert('orders', {
      stripe_session_id: session.id,
      stripe_payment_intent: session.payment_intent || null,
      email: (session.customer_details && session.customer_details.email) || null,
      amount_total: session.amount_total,
      currency: session.currency || 'usd',
      items: [],
      shipping: (session.customer_details && session.customer_details.address)
        ? { name: session.customer_details.name, address: session.customer_details.address }
        : null,
      status: 'paid'
    });
  } catch (e) {
    // 500 makes Stripe retry, which is what we want for a transient failure.
    console.error('Order insert failed', session.id, e);
    return { statusCode: 500, body: 'Insert failed' };
  }

  return { statusCode: 200, body: 'ok' };
};
