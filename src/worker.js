// Serves the site from static assets and runs the Netlify-style handlers in
// netlify/functions/ unchanged. The adapter below turns a Request into the v1
// event those handlers expect and their { statusCode, headers, body } back into
// a Response. The /.netlify/functions/ paths are kept so index.html, which is
// generated from a dc-runtime source not in this repo, needs no edit.

import auth from '../netlify/functions/auth.js';
import chat from '../netlify/functions/chat.js';
import consultations from '../netlify/functions/consultations.js';
import createCheckoutSession from '../netlify/functions/create-checkout-session.js';
import deleteAccount from '../netlify/functions/delete-account.js';
import getLogs from '../netlify/functions/get-logs.js';
import messages from '../netlify/functions/messages.js';
import profile from '../netlify/functions/profile.js';
import reminders from '../netlify/functions/reminders.js';
import sendReminders from '../netlify/functions/send-reminders.js';
import stripeWebhook from '../netlify/functions/stripe-webhook.js';
import wellnessChat from '../netlify/functions/wellness-chat.js';

const HANDLERS = {
  'auth': auth.handler,
  'chat': chat.handler,
  'consultations': consultations.handler,
  'create-checkout-session': createCheckoutSession.handler,
  'delete-account': deleteAccount.handler,
  'get-logs': getLogs.handler,
  'messages': messages.handler,
  'profile': profile.handler,
  'reminders': reminders.handler,
  'send-reminders': sendReminders.handler,
  'stripe-webhook': stripeWebhook.handler,
  'wellness-chat': wellnessChat.handler
};

const PREFIX = '/.netlify/functions/';

async function toEvent(request, url) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  // Read once, as text: the Stripe webhook verifies these exact bytes.
  const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
  return {
    httpMethod: request.method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body || null,
    isBase64Encoded: false
  };
}

function toResponse(result) {
  const r = result || {};
  const body = r.isBase64Encoded ? Uint8Array.from(atob(r.body || ''), c => c.charCodeAt(0)) : (r.body ?? null);
  return new Response(body, { status: r.statusCode || 200, headers: r.headers || {} });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // The app's old home. Its root was the recommender; other paths (the shop,
    // the notes) kept their names, so they map one to one.
    if (url.hostname === 'tea.laurelate.com') {
      const path = url.pathname === '/' ? '/recommend' : url.pathname;
      return Response.redirect(`https://apothecaryforest.com${path}${url.search}`, 301);
    }

    // 302, not 301: a permanent redirect would be cached in browsers and fight
    // a real home page when one ships.
    if (url.pathname === '/') {
      return new Response(null, { status: 302, headers: { Location: '/recommend' + url.search } });
    }

    if (url.pathname.startsWith(PREFIX)) {
      const handler = HANDLERS[url.pathname.slice(PREFIX.length).replace(/\/$/, '')];
      if (!handler) return new Response('Not found', { status: 404 });
      try {
        return toResponse(await handler(await toEvent(request, url)));
      } catch (err) {
        console.error(url.pathname, err);
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    return env.ASSETS.fetch(request);
  },

  // Fires only once a cron trigger is added to wrangler.jsonc (phase 5).
  async scheduled(controller, env, ctx) {
    const result = await sendReminders.handler();
    console.log('send-reminders:', result && result.body);
  }
};
