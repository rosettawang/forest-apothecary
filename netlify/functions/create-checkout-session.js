// Creates a Stripe Checkout Session for a shop order.
//
// Hosted Checkout rather than the Payment Element: Stripe collects the
// shipping address, handles SCA, and gives Apple Pay and Google Pay for
// free, which keeps PCI scope here at nothing.
//
// Prices are NEVER taken from the request. The browser sends ids and
// quantities; this file looks the price up in CATALOGUE. Anything else
// lets a customer set their own price by editing a fetch call.
//
// Raw https rather than the stripe package, to match the other functions
// in this directory and keep the dependency list empty.

const https = require('https');
const querystring = require('querystring');

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Amounts in cents. The single source of truth for what anything costs.
const CATALOGUE = {
  'thanaka-aftershave': { name: 'Thanaka Aftershave', amount: 2800, description: '30 ml' }
};

const SHIPPING_CENTS = 600;
const MAX_QTY = 10;

/** Flatten a nested object into Stripe's bracket form encoding. */
function flatten(obj, prefix, out) {
  out = out || {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else if (Array.isArray(value)) value.forEach((v, i) => {
      if (typeof v === 'object') flatten(v, `${path}[${i}]`, out);
      else out[`${path}[${i}]`] = v;
    });
    else out[path] = value;
  }
  return out;
}

function stripePost(path, params, key) {
  const payload = querystring.stringify(flatten(params));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Stripe-Version': '2024-06-20'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Stripe not configured' }) };
  }

  let items;
  try {
    items = (JSON.parse(event.body || '{}').items) || [];
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Bad request body' }) };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No items' }) };
  }

  const line_items = [];
  for (const item of items) {
    const product = CATALOGUE[item && item.id];
    if (!product) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown item: ${item && item.id}` }) };
    }
    const qty = Math.min(Math.max(parseInt(item.qty, 10) || 1, 1), MAX_QTY);
    line_items.push({
      quantity: qty,
      price_data: {
        currency: 'usd',
        unit_amount: product.amount,
        product_data: { name: product.name, description: product.description }
      }
    });
  }

  const site = process.env.SITE_URL || 'https://apothecary.rosettawang.org';

  const params = {
    mode: 'payment',
    // The session id lets the thank-you page greet them by order. It is NOT
    // proof of payment; only the webhook is. See stripe-webhook.js.
    success_url: `${site}/shop/thank-you?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/shop/thanaka-aftershave`,
    line_items,
    shipping_address_collection: { allowed_countries: ['US'] },
    shipping_options: [{
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name: 'Standard shipping',
        fixed_amount: { amount: SHIPPING_CENTS, currency: 'usd' }
      }
    }],
    // The card statement says LAURELATE. Buyers who bought from Forest
    // Apothecary will not recognise it, and an unrecognised descriptor is
    // one of the commonest causes of chargebacks, so name the shop here.
    payment_intent_data: { statement_descriptor_suffix: 'APOTHECARY' }
  };

  // Stripe Tax errors if the account has not registered for it, so it stays
  // off until STRIPE_TAX_ENABLED is set.
  if (process.env.STRIPE_TAX_ENABLED === 'true') {
    params.automatic_tax = { enabled: true };
  }

  try {
    const res = await stripePost('/v1/checkout/sessions', params, key);
    if (res.status >= 400) {
      console.error('Stripe error', res.status, res.body && res.body.error);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not start checkout' }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ url: res.body.url, id: res.body.id }) };
  } catch (e) {
    console.error('Checkout session failed', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not start checkout' }) };
  }
};
