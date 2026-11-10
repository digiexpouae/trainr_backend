ALTER TABLE "resident_locations"
	ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP;
