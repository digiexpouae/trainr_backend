-- A booking is held for a short time while the resident pays.
-- 'pending_payment' rows block the slot only while expires_at is in the future.
ALTER TYPE SESSION_STATUS ADD VALUE IF NOT EXISTS 'pending_payment' BEFORE 'requested';

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;
