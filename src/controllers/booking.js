const { z } = require('zod');
const { pool, withTransaction } = require('../config/db');
const validate = require('../utils/validate');



const AppError = require('../utils/AppError');
const auth = require('../services/auth');
const { BLOCKS_SLOT_SQL } = require('../services/slotHold');

// The address is saved first (POST /resident/locations); a booking only references it.
const bookingSchema = z.object({
  slotId: z.coerce.number().int().positive(),
  locationId: z.coerce.number().int().positive(),
  sessionDate: z.iso.date(),
  goals: z.string().trim().min(1).max(200),
  flatNo: z.string().trim().max(30).optional(),
  howToReach: z.string().trim().max(500).optional(),
});

const HOLD_MINUTES = 10;


function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
               
async function assertTrainerServes(db, slot, { latitude, longitude, buildingId }) {
  if (slot.scope === 'coverage_area') {
    const radius = Number(slot.radius_km);
    const distance = haversineKm(
      Number(slot.area_lat), Number(slot.area_lng), Number(latitude), Number(longitude)
    );
    if (distance > radius) {
      throw new AppError(
        400,
        `This trainer does not cover the selected location. They cover ${slot.area_name || 'a different area'} (within ${radius} km).`,
        { areaName: slot.area_name, radiusKm: radius, distanceKm: Number(distance.toFixed(2)) }
      );
    }
    return;
  }
  // The trainer's link to the building and the building itself must both be approved.
  const approved = await db.query(
    `SELECT 1 FROM trainer_buildings tb
       JOIN building b ON b.id = tb.building_id
      WHERE tb.id = $1 AND tb.building_id = $2
        AND tb.status = 'approved' AND b.status = 'approved'`,
    [slot.trainer_building_id, buildingId ?? null]
  );
  if (approved.rowCount === 0) {
    throw new AppError(400, 'This trainer does not serve the selected building.');
  }
}


// Loads the resident's saved address and checks the trainer can serve it.
async function resolveLocation(db, residentId, slot, locationId) {
  const { rows: [saved] } = await db.query(
    `SELECT rl.*, b.status AS building_status
       FROM resident_locations rl
       LEFT JOIN building b ON b.id = rl.building_id
      WHERE rl.id = $1 AND rl.resident_id = $2`,
    [locationId, residentId]
  );
  if (!saved) throw new AppError(404, 'Saved location not found');
  if (saved.latitude == null || saved.longitude == null || !saved.address) {
    throw new AppError(400, 'Saved location is missing an address or coordinates');
  }
  // A building the team hasn't approved yet can't be booked.
  if (saved.building_id != null && saved.building_status !== 'approved') {
    throw new AppError(
      400,
      'Your building is still under review. You can book once it is approved.',
      { buildingStatus: saved.building_status }
    );
  }
  await assertTrainerServes(db, slot, {
    latitude: saved.latitude,
    longitude: saved.longitude,
    buildingId: saved.building_id,
  });
  return saved;
}


async function createBooking(req, res) {
  const input = validate(bookingSchema, req.body);

  const user = await auth.findByFirebaseUid(req.user.uid);
  if (!user || user.role !== 'resident') throw new AppError(403, 'Only residents can book sessions');
  if (!user.is_active) throw new AppError(403, 'Account is deactivated');

  const session = await withTransaction(async (db) => {
    // Lock the slot so simultaneous bookings are checked one after the other.
    const slot = (
      await db.query(
        `SELECT s.id, s.trainer_id, s.day_of_week, s.start_time, s.end_time, s.price,
               s.scope, s.trainer_building_id,
               ca.area_name, ca.radius_km, ca.latitude AS area_lat, ca.longitude AS area_lng
           FROM trainer_slots s
           LEFT JOIN trainer_coverage_areas ca ON ca.id = s.coverage_area_id
           JOIN trainer_profiles tp ON tp.user_id = s.trainer_id
           JOIN users u ON u.id = tp.user_id
          WHERE s.id = $1 AND s.is_active AND tp.status = 'approved' AND u.is_active
          FOR UPDATE OF s`,
        [input.slotId]
      )
    ).rows[0];
    if (!slot) throw new AppError(404, 'Slot not found');

    // Date must be today or later and fall on the slot's weekday (0 = Sunday).
    const date = new Date(`${input.sessionDate}T00:00:00Z`);
    if (date.getUTCDay() !== slot.day_of_week) {
      throw new AppError(400, 'Date does not match the slot day');
    }
    if (input.sessionDate < new Date().toISOString().slice(0, 10)) {
      throw new AppError(400, 'Date is in the past');
    }

    // Cheap availability check first (the slot row is locked), before any location work.
    const taken = await db.query(
      `SELECT 1 FROM sessions
        WHERE slot_id = $1 AND session_date = $2
          AND ${BLOCKS_SLOT_SQL}
        LIMIT 1`,
      [slot.id, input.sessionDate]
    );
    if (taken.rowCount > 0) throw new AppError(409, 'Slot is no longer available');

    const location = await resolveLocation(db, user.id, slot, input.locationId);

    const { rows } = await db.query(
      `INSERT INTO sessions
         (resident_id, trainer_id, slot_id, session_date, start_time, end_time,
          status, price, goals, location_id, location_type, building_id, address,
          flat_no, how_to_reach, latitude, longitude, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_payment',$7,$8,$9,$10::text::session_location_type,
               $11,$12,$13,$14,$15,$16, now() + make_interval(mins => $17))
       RETURNING id, status, session_date, start_time, end_time, price, expires_at`,
      [
        user.id, slot.trainer_id, slot.id, input.sessionDate, slot.start_time, slot.end_time,
        slot.price, input.goals, location.id, location.type, location.building_id,
        location.address, input.flatNo ?? null, input.howToReach ?? null,
        location.latitude, location.longitude, HOLD_MINUTES,
      ]
    );
    return rows[0];
  });

  res.status(201).json({
    session: {
      id: session.id,
      status: session.status,
      sessionDate: session.session_date,
      startTime: session.start_time,
      endTime: session.end_time,
      address:session.address,
      price: Number(session.price),
      expiresAt: session.expires_at,
    },
  });
}


module.exports = { createBooking };
