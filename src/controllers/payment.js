const { z } = require('zod');
const validate = require('../utils/validate');
const AppError = require('../utils/AppError');
const { sendSuccess } = require('../utils/response');
const auth = require('../services/auth');
const payment = require('../services/payment');
const { getStripe, getWebhookSecret } = require('../config/stripe');

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

// POST /resident/sessions/:id/pay. The body is ignored: the price is read from the session.
async function payForSession(req, res) {
  const { id } = validate(paramsSchema, req.params);
  const user = await auth.requireResident(req);
  const result = await payment.createPaymentForSession(user, id);
  sendSuccess(res, { message: 'Payment created successfully', data: result });
}

// POST /payments/webhook. Needs the raw body (see server.js). No login: Stripe's
// signature is the proof. Only a verified event may change anything.
async function stripeWebhook(req, res) {
  const stripe = getStripe();
  const secret = getWebhookSecret(); // a missing secret is a server error, not a bad signature
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.log("error",err.message)
    console.error('Stripe webhook rejected:', err.message);
    throw new AppError(400, 'Invalid webhook signature');
  }
  try {
    await payment.handleStripeEvent(event);
  } catch (err) {
    // Log ids only, never the payload. Stripe retries after the 500.
    console.error(`Stripe webhook failed (event ${event.id}, ${event.type}):`, err.message);
    throw err;
  }
  res.json({ received: true });
}

module.exports = { payForSession, stripeWebhook };
