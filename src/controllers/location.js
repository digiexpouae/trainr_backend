const { z } = require('zod');
const { pool, withTransaction } = require('../config/db');
const validate = require('../utils/validate');
const AppError = require('../utils/AppError');
const auth = require('../services/auth');

// Names the advisory lock used while saving a resident's location.
const LOCATION_LOCK = 1001;

const managementSchema = z.object({
  companyName: z.string().trim().max(100).optional(),
  contactName: z.string().trim().min(1).max(100),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().max(100).optional(),
});

// "Other" in the building list: the resident types a building we don't have yet.
const newBuildingSchema = z.object({
  name: z.string().trim().min(1).max(50),
  management: managementSchema.optional(),
});

// An apartment address (type 'building') uses either an existing approved building
// (buildingId) or a new one (newBuilding). Any other type has no building.
const locationSchema = z
  .object({
    type: z.enum(['home', 'work', 'building', 'other']).default('other'),
    label: z.string().trim().max(50).optional(),
    address: z.string().trim().min(1).max(200),
    latitude: z.coerce.number().min(-90).max(90),
    longitude: z.coerce.number().min(-180).max(180),
    buildingId: z.coerce.number().int().positive().optional(),
    newBuilding: newBuildingSchema.optional(),
  })
  .refine(
    (l) =>
      l.type === 'building'
        ? (l.buildingId == null) !== (l.newBuilding == null)
        : l.buildingId == null && l.newBuilding == null,
    {
      message: "Apartments need either buildingId or newBuilding; other types need neither",
      path: ['buildingId'],
    }
  );

async function requireResident(req) {
  const user = await auth.findByFirebaseUid(req.user.uid);
  if (!user || user.role !== 'resident') throw new AppError(403, 'Only residents can manage locations');
  if (!user.is_active) throw new AppError(403, 'Account is deactivated');
  return user;
}

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

// Only the details of the place can change. Type and building stay as saved;
// to move to another building the resident saves a new address.



module.exports = { listLocations, listBuildings, createLocation };
