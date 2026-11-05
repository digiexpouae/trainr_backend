-- Stripe webhook events already handled. The primary key makes a replayed event a no-op.
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" VARCHAR NOT NULL,
	"type" VARCHAR NOT NULL,
	"received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY("id")
);

-- A session can have only one open or paid charge at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_one_active_charge_uq"
ON "transactions" ("session_id")
WHERE "type" = 'charge' AND "status" IN ('pending', 'succeeded');

CREATE INDEX IF NOT EXISTS "transactions_session_idx"
ON "transactions" ("session_id");
