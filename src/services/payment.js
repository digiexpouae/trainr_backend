const { withTransaction } = require('../config/db');
const { getStripe } = require('../config/stripe');
const AppError = require('../utils/AppError');
const { BLOCKS_SLOT_SQL } = require('./slotHold');

const CURRENCY = 'aed';
// Once an intent exists the resident gets this long (from that moment) to pay.
const PAYMENT_WINDOW_MINUTES = 15;
const OPEN_INTENT_STATES = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

// Stripe amounts are in the smallest unit (fils for AED).
const toMinorUnits = (price) => Math.round(Number(price) * 100);

// Starts (or resumes) payment for the resident's own pending_payment session.
// The amount always comes from sessions.price, never from the request.
async function createPaymentForSession(user, sessionId) {
  const stripe = getStripe();

  return withTransaction(async (db) => {
    const { rows: [session] } = await db.query(
      `SELECT id, resident_id, status, price, expires_at, expires_at > now() AS hold_active
         FROM sessions WHERE id = $1 FOR UPDATE`,
      [sessionId]
    );
    // Same 404 for someone else's session, so ids can't be probed.
    if (!session || session.resident_id !== user.id) throw new AppError(404, 'Session not found');
    if (session.status !== 'pending_payment') {
      throw new AppError(409, 'Session is not waiting for payment');
    }
    if (!session.hold_active) throw new AppError(409, 'Payment window has expired. Book again.');

    const amount = toMinorUnits(session.price);
    if (!(amount > 0)) throw new AppError(400, 'Session has no price to pay');

    const { rows: charges } = await db.query(
      `SELECT id, status, provider_ref FROM transactions
        WHERE session_id = $1 AND type = 'charge' ORDER BY created_at`,
      [session.id]
    );

    // Reuse the open payment so a retry never creates a second charge.
    const open = charges.find((c) => c.status === 'pending');
    if (open) {
      const intent = await stripe.paymentIntents.retrieve(open.provider_ref);
      if (OPEN_INTENT_STATES.includes(intent.status)) {
        return {
          clientSecret: intent.client_secret,
          amount: intent.amount,
          currency: CURRENCY,
          expiresAt: session.expires_at,
        };
      }
      if (intent.status === 'processing' || intent.status === 'succeeded') {
        throw new AppError(409, 'Payment is already in progress');
      }
      await db.query(
        `UPDATE transactions SET status = 'failed', failure_reason = $2, updated_at = now()
          WHERE id = $1`,
        [open.id, `intent_${intent.status}`]
      );
    }

    const intent = await stripe.paymentIntents.create(
      {
        amount,
        currency: CURRENCY,
        automatic_payment_methods: { enabled: true },
        metadata: { session_id: String(session.id), resident_id: String(user.id) },
      },
      { idempotencyKey: `pay-session-${session.id}-attempt-${charges.length + 1}` }
    );

    await db.query(
      `INSERT INTO transactions
         (resident_id, session_id, amount, currency, type, status, provider, provider_ref)
       VALUES ($1, $2, $3, 'AED', 'charge', 'pending', 'stripe', $4)`,
      [user.id, session.id, session.price, intent.id]
    );

    // First intent: the resident gets a full payment window from now. Later intents
    // (after a canceled/failed one) keep the deadline, so the hold cannot be stretched forever.
    const { rows: [held] } = await db.query(
      `UPDATE sessions
          SET expires_at = CASE WHEN $3 THEN GREATEST(expires_at, now() + make_interval(mins => $2))
                                ELSE expires_at END,
              updated_at = now()
        WHERE id = $1
        RETURNING expires_at`,
      [session.id, PAYMENT_WINDOW_MINUTES, charges.length === 0]
    );

    return {
      clientSecret: intent.client_secret,
      amount,
      currency: CURRENCY,
      expiresAt: held.expires_at,
    };
  });
}

// Refunds inside the DB transaction: if Stripe fails the whole event rolls back
// and Stripe retries the webhook later.
//
// SWAP POINT: every refund (amount_mismatch, session_not_payable, slot_taken) goes
// through this one function, both from the webhook and from the expire job
// (jobs/expirePendingPayments.js reconcile). To refund to the user's wallet instead
// of Stripe, replace only the body here (credit wallet + mark tx 'refunded' in the
// same db transaction). No caller needs to change.
async function refundCharge(db, tx, intent, reason) {
  await getStripe().refunds.create(
    { payment_intent: intent.id },
    { idempotencyKey: `refund-${intent.id}` }
  );
  await db.query(
    `UPDATE transactions
        SET status = 'refunded', failure_reason = $2, provider_charge_id = $3, updated_at = now()
      WHERE id = $1`,
    [tx.id, reason, intent.latest_charge ?? null]
  );
}

async function onPaymentSucceeded(db, intent) {
  const { rows: [tx] } = await db.query(
    `SELECT id, session_id, status FROM transactions WHERE provider_ref = $1 FOR UPDATE`,
    [intent.id]
  );
  if (!tx) {
    console.warn(`[payment] succeeded intent ${intent.id} has no transaction, ignoring`);
    return;
  }
  if (tx.status !== 'pending') {
    console.log("duplicate payment")
    return;
  }
  const { rows: [session] } = await db.query(
    `SELECT id, status, price, slot_id, session_date, expires_at > now() AS hold_active
       FROM sessions WHERE id = $1 FOR UPDATE`,
    [tx.session_id]
  );

  // Paid amount must match what we priced. Otherwise give the money back.
  const amountOk =
    intent.amount_received === toMinorUnits(session.price) && intent.currency === CURRENCY;
  if (!amountOk) return refundCharge(db, tx, intent, 'amount_mismatch');

  if (session.status !== 'pending_payment') return refundCharge(db, tx, intent, 'session_not_payable');

  // Paid after the hold ran out: keep the booking only if nobody else took the slot.
  if (!session.hold_active) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM sessions
        WHERE slot_id = $1 AND session_date = $2 AND id <> $3
          AND ${BLOCKS_SLOT_SQL}
        LIMIT 1`,
      [session.slot_id, session.session_date, session.id]
    );
    if (rowCount > 0) return refundCharge(db, tx, intent, 'slot_taken');
  }

  await db.query(
    `UPDATE sessions SET status = 'requested', expires_at = NULL, updated_at = now() WHERE id = $1`,
    [session.id]
  );
  await db.query(
    `UPDATE transactions SET status = 'succeeded', provider_charge_id = $2, failure_reason = NULL,
            updated_at = now()
      WHERE id = $1`,
    [tx.id, intent.latest_charge ?? null]
  );
}

async function onPaymentFailed(db, intent) {
  await db.query(
    `UPDATE transactions SET failure_reason = $2, updated_at = now()
      WHERE provider_ref = $1 AND status = 'pending'`,
    [intent.id, intent.last_payment_error?.code ?? 'payment_failed']
  );
}

// A canceled intent can never be paid, so its pending charge is final.
async function onPaymentCanceled(db, intent) {
  await db.query(
    `UPDATE transactions SET status = 'failed', failure_reason = 'canceled', updated_at = now()
      WHERE provider_ref = $1 AND status = 'pending'`,
    [intent.id]
  );
}

// Called only with an event whose signature was already verified.
async function handleStripeEvent(event) {
  await withTransaction(async (db) => {
    // Already handled (Stripe retries and may repeat events): do nothing.
    const { rowCount } = await db.query(
      'INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [event.id, event.type]
    );
    if (rowCount === 0) return;

    const intent = event.data.object;
    if (event.type === 'payment_intent.succeeded') await onPaymentSucceeded(db, intent);
    else if (event.type === 'payment_intent.payment_failed') await onPaymentFailed(db, intent);
    else if (event.type === 'payment_intent.canceled') await onPaymentCanceled(db, intent);
  });
}

module.exports = { createPaymentForSession, handleStripeEvent,onPaymentSucceeded };
