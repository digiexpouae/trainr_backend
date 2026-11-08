const { pool, withTransaction } = require('../config/db');
const { getStripe } = require('../config/stripe');
const { onPaymentSucceeded } = require('../services/payment');

const INTERVAL_MS = 60 * 1000;
const BATCH_SIZE = 20;
// Stripe states where no money has moved yet, so the intent can be canceled safely.
const CANCELABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

// Closes one expired pending_payment session. Returns what happened:
//   'expired'    - intent closed (or none existed), session no longer blocks the slot
//   'reconciled' - customer had paid but the webhook never arrived; we ran the same
//                  success logic as the webhook (booking confirmed, or refunded if the
//                  slot was taken meanwhile - then the session expires next round)
//   'kept'       - payment is still processing at Stripe; the webhook decides
//   'busy'       - another instance, the webhook or /pay holds the row; try next round
async function expireSession(sessionId, txId) {
  // Stripe calls happen BEFORE any DB lock, so a slow Stripe never holds row locks.
  // State may change meanwhile (e.g. the webhook arrives); onPaymentSucceeded and the
  // status checks below re-read the DB under lock, so a stale intent is harmless.
  let intent = null; // null = no intent exists at Stripe
  if (txId) {
    const { rows } = await pool.query(
      `SELECT provider_ref FROM transactions WHERE id = $1 AND status = 'pending'`,
      [txId]
    );
    if (rows.length === 0) return 'busy';
    const stripe = getStripe();
    try {
      intent = await stripe.paymentIntents.retrieve(rows[0].provider_ref);
      if (CANCELABLE.includes(intent.status)) {
        // Throws if the payment moved on in the meantime: retried next round.
        intent = await stripe.paymentIntents.cancel(rows[0].provider_ref);
      }
    } catch (err) {
      if (err.code !== 'resource_missing') throw err; // Stripe/network trouble: retry later
      intent = null;
    }
    // processing (or any other non-final state): Stripe decides, webhook will follow.
    if (intent && !['succeeded', 'canceled'].includes(intent.status)) return 'kept';
  }

  return withTransaction(async (db) => {
    // Lock order matches the webhook (transaction first, then session) to avoid deadlocks.
    // SKIP LOCKED lets several server instances share the work without doubling it.
    let tx = null;
    if (txId) {
      const { rows } = await db.query(
        `SELECT id FROM transactions
          WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
        [txId]
      );
      if (rows.length === 0) return 'busy';
      tx = rows[0];
    }

    const { rowCount } = await db.query(
      `SELECT 1 FROM sessions
        WHERE id = $1 AND status = 'pending_payment' AND expires_at < now()
        FOR UPDATE SKIP LOCKED`,
      [sessionId]
    );
    if (rowCount === 0) return 'busy';

    if (tx) {
      if (intent && intent.status === 'succeeded') {
        // Missed webhook: run exactly what the webhook would have run. If the real
        // webhook arrives later, tx is no longer pending and it returns early.
        await onPaymentSucceeded(db, intent);
        return 'reconciled';
      }

      await db.query(
        `UPDATE transactions SET status = 'failed', failure_reason = 'expired', updated_at = now()
          WHERE id = $1`,
        [tx.id]
      );
    }

    await db.query(
      `UPDATE sessions SET status = 'expired', updated_at = now() WHERE id = $1`,
      [sessionId]
    );
    return 'expired';
  });
}

let running = false;

async function runOnce() {
  if (running) return; // previous round still going
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT s.id,
              (SELECT t.id FROM transactions t
                WHERE t.session_id = s.id AND t.type = 'charge' AND t.status = 'pending'
                ORDER BY t.created_at DESC LIMIT 1) AS tx_id
         FROM sessions s
        WHERE s.status = 'pending_payment' AND s.expires_at < now()
        ORDER BY s.expires_at
        LIMIT $1`,
      [BATCH_SIZE]
    );

    for (const row of rows) {
      try {
        const result = await expireSession(row.id, row.tx_id);
        if (result !== 'busy') console.log(`[expire-payments] session ${row.id}: ${result}`);
      } catch (err) {
        console.error(`[expire-payments] session ${row.id} failed, will retry:`, err.message);
      }
    }
  } catch (err) {
    console.error('[expire-payments] round failed:', err.message);
  } finally {
    running = false;
  }
}

function startExpirePendingPayments() {
  setTimeout(runOnce, 5000).unref(); // clean stale rows soon after boot
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { startExpirePendingPayments, runOnce };
