# Edge cases: resident locations

## Create (`POST /locations`)

| Case | Status | Behaviour |
|---|---|---|
| Same address + same building, same resident | Done | Returns 200 with the saved one (`alreadySaved`). A new label updates it. |
| Same address, no building (`home`, `work`, `other`) | Done | Same rule. A repeat keeps the first saved type. |
| Same address as `home` and as `building` | Accepted | Two rows, since the building differs. A session copies the address, so no harm. |
| Double tap (two requests at once) | Done | A lock per resident makes the second wait, then it returns the saved one. |
| New building with a name that already exists | Done | 409. Says it exists, or is waiting for approval. |
| Similar building names (Kamdar, Kamdar Dev) | Open | Admin merges, or Google suggestions. |
| Two users add the same new building at once | Open | Two `pending` copies are made. Fix: lock or unique name. Fallback: admin merge. |


## To do
- Google suggestion on the building field, so users pick a correct name.
- Split `createLocation` into small helper functions.
- Change the update route to `PATCH /locations/:id`.


## Update (`PUT /location/:id`)

| Case | Status | Behaviour |
|---|---|---|
| Location missing or not the resident's | Done | 404. |
| New address matches another saved one (same building) | Done | 409. |
| Nothing to update, or only one of latitude/longitude | Done | 400. |
| Success | Done | Returns the updated location with building details. |
| Type and building change | Not allowed | Save a new address instead. |
| Update sends a different `type` or `buildingId`, or any `newBuilding` | Done | 400, nothing is saved. |
| Update sends the same `type` / `buildingId` as saved | Done | Accepted and ignored, so a full object can be sent back. |

## Delete (`DELETE /locations/:id`)

| Case | Status | Behaviour |
|---|---|---|
| Location missing or not the resident's | Done | 404. |
| Address was used for a booking | Done | 409. Kept, because the session still points to it. |
| Invalid `:id` (not a positive number) | Done | 400. |
| Not a resident, or account deactivated | Done | 403. |
| Success | Done | 200 with a message. |
| Delete the same address twice | Done | The second call returns 404. |
| Building of the deleted address | Untouched | Other residents may share it. |
| Resident wants to delete an address used for a booking | Open | Blocked today (409). Soft delete (`deleted_at`) is not integrated yet: it would hide the address from the resident and keep the row for the booking. |
