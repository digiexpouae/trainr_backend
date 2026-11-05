const { locationSchema,updateLocationSchema,locationIdSchema } = require('../validators/location');
const { pool, withTransaction } = require('../config/db');
const validate = require('../utils/validate');
const AppError = require('../utils/AppError');
const { requireResident } = require('../services/auth');

// Names the advisory lock used while saving a resident's location.
const LOCATION_LOCK = 1001;

const toLocation = (r) => ({
  id: r.id,
  type: r.type,
  label: r.label,
  address: r.address,
  latitude: r.latitude == null ? null : Number(r.latitude),
  longitude: r.longitude == null ? null : Number(r.longitude),
  buildingId: r.building_id,
  buildingName: r.building_name ?? null,
  buildingStatus: r.building_status ?? null,
});

// GET /resident/locations: the resident's saved addresses.
async function listLocations(req, res) {
  const user = await requireResident(req);
  const { rows } = await pool.query(
    `SELECT rl.*, b.name AS building_name, b.status AS building_status
       FROM resident_locations rl
       LEFT JOIN building b ON b.id = rl.building_id
      WHERE rl.resident_id = $1
      ORDER BY rl.is_default DESC, rl.created_at DESC`,
    [user.id]
  );
  res.json({ locations: rows.map(toLocation) });
}

// GET /resident/buildings: approved buildings for the apartment picker.
// The app adds the "Other" option itself.
async function listBuildings(req, res) {
  await requireResident(req);
  const { rows } = await pool.query(
    `SELECT id, name, location FROM building WHERE status = 'approved' ORDER BY name`
  );
  res.json({ buildings: rows.map((b) => ({ id: b.id, name: b.name, location: b.location })) });
}

// POST /resident/locations: saves an address to the resident's profile.
// A new building is created as 'pending' so the team can review it.
async function createLocation(req, res) {
  const input = validate(locationSchema, req.body);
  const user = await requireResident(req);
  const { row, alreadySaved } = await withTransaction(async (db) => {
    // One save at a time per resident, so a double tap can't insert the same address twice.
    // The lock is released automatically at commit or rollback.
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCATION_LOCK, user.id]);

    // Same resident + same address + same building is the same place: reuse it,
    // and take the label if the resident sent a new one.
    const { rows: [saved] } = await db.query(
      `SELECT rl.*, b.name AS building_name, b.status AS building_status
         FROM resident_locations rl
         LEFT JOIN building b ON b.id = rl.building_id
        WHERE rl.resident_id = $1
          AND lower(btrim(rl.address)) = lower($2)
          AND (($3::int IS NOT NULL AND rl.building_id = $3)
               OR ($4::text IS NOT NULL AND lower(btrim(b.name)) = lower($4))
               OR ($3::int IS NULL AND $4::text IS NULL AND rl.building_id IS NULL))
        LIMIT 1`,
      [user.id, input.address, input.buildingId ?? null, input.newBuilding?.name ?? null]
    );
    if (saved) {
      if (input.label != null && input.label !== saved.label) {
        await db.query('UPDATE resident_locations SET label = $1 WHERE id = $2', [input.label, saved.id]);
        saved.label = input.label;
      }
      return { row: saved, alreadySaved: true };
    }

    let buildingId = input.buildingId ?? null;

    if (buildingId != null) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM building WHERE id = $1 AND status = 'approved'",
        [buildingId]
      );
      if (rowCount === 0) throw new AppError(404, 'Building not found');
    } else if (input.newBuilding) {
      const { name, management } = input.newBuilding;

      // Don't create a second copy of a building that is already approved or waiting for review.
      const { rows: [existing] } = await db.query(
        `SELECT id, name, status FROM building
          WHERE status IN ('approved', 'pending') AND lower(btrim(name)) = lower($1)
          ORDER BY status = 'approved' DESC
          LIMIT 1`,
        [name]
      );
      if (existing) {
        throw new AppError(
          409,
          existing.status === 'approved'
            ? 'This building already exists. Please select it from the list.'
            : 'This building is already submitted and waiting for approval.',
          { building: { id: existing.id, name: existing.name, status: existing.status } }
        );
      }

      const created = await db.query(
        `INSERT INTO building (name, location, status, created_by)
         VALUES ($1, $2, 'pending', $3) RETURNING id`,
        [name, input.address.slice(0, 100), user.id]
      );
      buildingId = created.rows[0].id;
      if (management) {
        await db.query(
          `INSERT INTO building_management
             (building_id, company_name, contact_name, contact_phone, contact_email)
           VALUES ($1, $2, $3, $4, $5)`,
          [buildingId, management.companyName ?? null, management.contactName,
           management.contactPhone ?? null, management.contactEmail ?? null]
        );
      }
    }

    const { rows } = await db.query(
      `INSERT INTO resident_locations
         (resident_id, type, label, address, latitude, longitude, building_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [user.id, input.type, input.label ?? null, input.address, input.latitude,
       input.longitude, buildingId]
    );
    const { rows: [b] } = buildingId == null
      ? { rows: [{}] }
      : await db.query('SELECT name, status FROM building WHERE id = $1', [buildingId]);
    return { row: { ...rows[0], building_name: b.name, building_status: b.status }, alreadySaved: false };
  });

  if (alreadySaved) {
    return res.status(200).json({
      location: toLocation(row),
      alreadySaved: true,
      message: 'You already have this address saved.',
    });
  }

  res.status(201).json({
    location: toLocation(row),
    ...(row.building_status === 'pending' && {
      message: 'Building submitted for review. You can book once it is approved.',
    }),
  });
}


async function findLocation(db, id, residentId) {
  const { rows: [location] } = await db.query(
    `SELECT rl.*, b.name AS building_name, b.status AS building_status
       FROM resident_locations rl
       LEFT JOIN building b ON b.id = rl.building_id
      WHERE rl.id = $1 AND rl.resident_id = $2`,
    [id, residentId]
  );
  return location;
}

// Does the resident already have another saved place with this address and building?
async function addressTaken(db, residentId, buildingId, address, exceptId) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM resident_locations
      WHERE resident_id = $1 AND id <> $2
        AND lower(btrim(address)) = lower($3)
        AND building_id IS NOT DISTINCT FROM $4`,
    [residentId, exceptId, address, buildingId]
  );
  return rowCount > 0;
}

// PATCH /resident/locations/:id: changes the label, address or coordinates of a saved address.
// Existing sessions keep their own copy of the address, so they are not affected.
async function updateLocation(req, res) {
  const { id } = validate(locationIdSchema, req.params);
  const input = validate(updateLocationSchema, req.body);
  const user = await requireResident(req);

  const row = await withTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCATION_LOCK, user.id]);

    const current = await findLocation(db, id, user.id);
    if (!current) throw new AppError(404, 'Location not found');

    // type and building may be sent back unchanged, but not edited.
    if (input.type !== undefined && input.type !== current.type) {
      throw new AppError(400, 'type cannot be changed');
    }
    if (input.buildingId !== undefined && (input.buildingId ?? null) !== current.building_id) {
      throw new AppError(400, 'building cannot be changed');
    }

    // Only check for a duplicate when the address text actually changes.
    const addressChanged =
      input.address !== undefined &&
      input.address.trim().toLowerCase() !== (current.address ?? '').trim().toLowerCase();
    if (addressChanged && await addressTaken(db, user.id, current.building_id, input.address, id)) {
      throw new AppError(409, 'You already have this address saved.');
    }

    await db.query(
      `UPDATE resident_locations
          SET label = COALESCE($1, label),
              address = COALESCE($2, address),
              latitude = COALESCE($3, latitude),
              longitude = COALESCE($4, longitude),
              updated_at = now()
        WHERE id = $5`,
      [input.label ?? null, input.address ?? null, input.latitude ?? null,
       input.longitude ?? null, id]
    );
    return findLocation(db, id, user.id);
  });

  res.json({ location: toLocation(row) });
}

// DELETE /resident/locations/:id: removes one of the resident's saved addresses.
// Sessions keep their own copy of the address; their location_id is set to NULL on delete.
async function deleteLocation(req, res) {
  const { id } = validate(locationIdSchema, req.params);
  const user = await requireResident(req);

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM resident_locations WHERE id = $1 AND resident_id = $2',
      [id, user.id]
    );
    if (rowCount === 0) throw new AppError(404, 'Location not found');
  } catch (err) {
    if (err.code === '23503') {
      throw new AppError(409, 'This address was used for a booking and cannot be deleted.');
    }
    console.log("error",err)
    throw err;
  }

res.status(200).json({
  message: "Location Deleted successfully",
});
}

module.exports = { listLocations, listBuildings, createLocation, updateLocation, deleteLocation };
