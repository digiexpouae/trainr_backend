# Edge cases: POST /api/resident/locations

- **Similar building names** (Kamdar, Kamdar Dev): open. Admin merges, or Google suggestions.
- **Same building + same address (same resident):** resolved. Returns 200 with the existing location; a new label updates it.

- **Type `other` + same address:** resolved. Same rule, no building. A repeat keeps the first saved type.

- **Same address as `home` and as `building`:** two rows (the building differs). Accepted: a session copies the address, so it does no harm.

- **Double taps by same user holds second 
request to avoid duplicate insertions.
- **Two users add the same new building at once:** open. Both pass the name check, so two `pending` copies are made. Fix: lock or unique name. Fallback: admin merge.

- **Google suggestion on the building field:** planned. Users pick a correct name instead of typing, so fewer duplicates.

- **Clean up `createLocation`:** to do. Split it into small helper functions (find saved location, resolve building, insert location) so the endpoint reads in a few lines.
