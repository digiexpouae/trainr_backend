-- A pending_payment session whose payment window ran out and whose Stripe intent
-- was closed by the scheduler. It no longer blocks its slot.
ALTER TYPE SESSION_STATUS ADD VALUE IF NOT EXISTS 'expired';
