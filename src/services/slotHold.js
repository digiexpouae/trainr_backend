// SQL condition for "this row of sessions still blocks its slot". Use it in a query
// that reads FROM sessions (unaliased).
//
// A pending_payment session blocks the slot while its hold is running, and after that
// for as long as a charge is still open. The scheduler closes the Stripe intent first
// and only then marks the session expired, so a payment that is still possible never
// loses its slot to someone else.
const BLOCKS_SLOT_SQL = `(
  status IN ('requested','accepted','confirmed','in_progress')
  OR (status = 'pending_payment' AND (
        expires_at > now()
        OR EXISTS (SELECT 1 FROM transactions t
                    WHERE t.session_id = sessions.id
                      AND t.type = 'charge' AND t.status = 'pending')))
)`;

module.exports = { BLOCKS_SLOT_SQL };
