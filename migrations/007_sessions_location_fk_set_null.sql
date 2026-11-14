-- Sessions keep their own copy of the address, so deleting a saved location
-- should not be blocked by old sessions. Their location_id becomes NULL instead.
-- (location_id was already made nullable in 006.)
ALTER TABLE "sessions"
DROP CONSTRAINT IF EXISTS "sessions_location_id_fkey";

ALTER TABLE "sessions"
ADD CONSTRAINT "sessions_location_id_fkey"
FOREIGN KEY ("location_id") REFERENCES "resident_locations"("id")
ON DELETE SET NULL;
