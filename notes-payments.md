# Payments and slot hold

## The idea in 5 lines
1. Resident books a slot. The slot is held for **10 minutes** while the resident pays.
2. Resident taps pay (`POST /resident/sessions/:id/pay`). We create a Stripe intent. From that moment the resident has **15 minutes** to pay.
3. Stripe tells us the result by webhook (`POST /payments/webhook`). Paid: the booking is confirmed.
4. If the resident never pays, a **scheduler** (runs every minute) closes the intent and frees the slot.
5. A slot is free only when we are sure no payment can still arrive. This means no "paid, but the slot was given to someone else, so refund".

## Timeline (example)

| Time | What happens | Slot |
|---|---|---|
| 0:00 | Resident books. Session is `pending_payment`, `expires_at` = 0:10. | Held |
| 0:03 | Resident taps pay. Intent is created. `expires_at` = 0:18. | Held |
| 0:12 | Resident pays. Webhook arrives. Session becomes `requested`. | Booked |
| 0:18 (no payment) | Scheduler cancels the intent. Session becomes `expired`. | Free |

If the resident never taps pay: the hold ends at 0:10 and the slot is free right away (no intent exists, nothing to cancel).

## Times

| Name | Value | Where |
|---|---|---|
| Hold after booking | 10 min | `HOLD_MINUTES` in `controllers/booking.js` |
| Pay window after the intent is created | 15 min | `PAYMENT_WINDOW_MINUTES` in `services/payment.js` |
| Scheduler runs | every 1 min (and 5 sec after start) | `jobs/expirePendingPayments.js` |
| Longest a slot can be held | about 25 min (10 to create the intent + 15 to pay) | |

The 15 minutes count from when the intent is created, not from the booking. Only the first intent gets the 15 minutes. A second intent keeps the old deadline, so the hold can't be stretched forever.

## Session status

| Status | Meaning |
|---|---|
| `pending_payment` | Booked, waiting for payment. |
| `requested` | Paid. Waiting for the trainer. |
| `expired` | Payment window ended and the intent was closed. Slot is free. |
| `cancelled`, `declined` | Do not hold the slot. |

## When does a session block its slot?
Code: `services/slotHold.js`. A slot is blocked if **any one** of these is true:

| Clause | Condition | Why |
|---|---|---|
| A | Status is `requested`, `accepted`, `confirmed` or `in_progress` | A real booking. |
| B | Status is `pending_payment` and `expires_at` is still in the future | The hold is running. |
| C | Status is `pending_payment`, `expires_at` has passed, **but** a charge is still `pending` (intent open) | The resident may still pay. Slot stays blocked until the scheduler closes the intent. |

If none is true, the slot is free.

## Scheduler (`jobs/expirePendingPayments.js`)
Looks at sessions that are `pending_payment` and past `expires_at`. For each one it checks the Stripe intent:

| Stripe intent state | Money moved? | Scheduler does |
|---|---|---|
| No intent was ever created | No | Session `expired`. Slot free. |
| `requires_payment_method`, `requires_confirmation`, `requires_action` | No | Cancel the intent. Transaction `failed`. Session `expired`. Slot free. |
| `canceled` already | No | Transaction `failed`. Session `expired`. Slot free. |
| `succeeded` | Yes (webhook was missed) | **Reconcile:** run the same logic as the webhook (`onPaymentSucceeded`). Booking becomes `requested`, or the charge is refunded if the slot was taken meanwhile (then the session expires next round). A late real webhook does nothing, the transaction is already final. |
| `processing` | On the way | Do nothing. The webhook confirms the booking. Slot stays blocked. |
| Stripe error (network etc.) | Unknown | Do nothing. Try again next minute. |
| Intent not found at Stripe | No | Treated like canceled. |

How it stays safe:
- **Many servers:** each session is locked with `FOR UPDATE SKIP LOCKED`. A server skips a session another server is working on.
- **Locks order:** transaction first, then session. The webhook uses the same order, so they never block each other forever.
- **Stripe decides a race:** if the resident confirms payment at the same moment, Stripe refuses the cancel. The scheduler then skips and the webhook wins.
- **Stripe calls happen before any DB lock**, so a slow Stripe never holds row locks. The state is re-read under lock afterwards.
- **Refunds** all go through `refundCharge` in `services/payment.js`. Switching to wallet refunds means changing only that function.
- **One session at a time**, each in its own DB transaction. One failure does not stop the others.
- **No overlap:** if a round is still running, the next one is skipped.

## Pay endpoint (`POST /resident/sessions/:id/pay`)

| Case | Result |
|---|---|
| Session is not this resident's, or missing | 404 (same message, so ids can't be guessed) |
| Session is not `pending_payment` | 409 |
| Hold has ended (`expires_at` passed) | 409 "Book again" |
| Session has no price | 400 |
| An open intent already exists | Same intent is returned. No second charge. |
| Intent is `processing` or `succeeded` | 409 "already in progress" |
| Old intent is dead (canceled etc.) | Old transaction `failed`, a new intent is created |
| Price | Always read from `sessions.price`, never from the request |

The response has `clientSecret`, `amount`, `currency` and `expiresAt` (the real pay deadline).

## Webhook (`POST /payments/webhook`)

| Case | Behaviour |
|---|---|
| Bad signature | 400. Nothing changes. |
| Same event sent twice | Event id is saved in `stripe_events`. The second one is ignored. |
| `payment_intent.succeeded` | Session becomes `requested`. Transaction `succeeded`. |
| `payment_intent.payment_failed` (card declined) | Transaction stays `pending`, only `failure_reason` is saved. The resident can retry on the same intent. |
| `payment_intent.canceled` | Transaction `failed`. |
| Succeeded, but the paid amount is wrong | Refund. |
| Succeeded, but the session is no longer `pending_payment` | Refund. |
| Succeeded after the hold ended, and another booking took the slot | Refund. Should almost never happen now, because clause C keeps the slot blocked. |
| Refund fails at Stripe | Whole event rolls back. Stripe sends it again later. |

## Edge cases

| Case | Status | Behaviour |
|---|---|---|
| Resident pays at minute 12 (after the 10 min hold, inside the 15 min window) | Done | Works. Slot was still blocked (clause C). No refund. |
| Resident never taps pay | Done | Hold ends at 10 min. Slot free. Scheduler marks the session `expired`. |
| Resident taps pay, never pays | Done | Scheduler cancels the intent after the window. Slot free. |
| Resident is typing the card when the scheduler cancels | Accepted | Stripe refuses the payment. No money is taken. Resident books again. |
| Payment is `processing` when the window ends | Done | Scheduler skips. Webhook decides. Slot stays blocked. |
| Pay tapped after the hold ended | Done | 409. |
| Two servers run the scheduler | Done | `SKIP LOCKED`. One handles a session, the other skips it. |
| Scheduler is not running | Done | Sessions without an intent still free the slot by time. Sessions with an open intent stay blocked until it runs again. |
| Stripe is down | Done | Scheduler retries every minute. Slot stays blocked meanwhile. |
| Old stale rows (like session 8) | Done | Scheduler cleans them in its first rounds after start. |

## Open / to do
- Run `npm run migrate` (migration `004` adds the `expired` status).
- Test: pay inside 15 min after the hold ended, no pay, two servers at once.
- Duplicate Stripe events: test `stripe events resend`, same event at the same time, out of order.
- Booking response still shows a 10 minute `expiresAt`. The app should show the `expiresAt` from the pay response once the intent exists.
- Session 11 is stale test data (`failed` but paid at Stripe).
- A payment stuck in `processing` for a very long time holds the slot. Not handled yet.
