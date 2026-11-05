const Stripe = require('stripe');

let client;

// Built on first use, so the server still starts when Stripe is not configured yet.
function getStripe() {
  if (client) return client;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  if (key.startsWith('sk_live_') && process.env.NODE_ENV !== 'production') {
    throw new Error('Live Stripe key is not allowed outside production');
  }

  client = new Stripe(key, { maxNetworkRetries: 2 });
  return client;
}

function getWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return secret;
}

module.exports = { getStripe, getWebhookSecret };
