const { z } = require('zod');
const { pool, withTransaction } = require('../config/db');
const validate = require('../utils/validate');
const { requireResident } = require('../services/auth');


const searchSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

const slotsParamsSchema = z.object({
  coverageAreaId: z.coerce.number().int().positive(),
});

// Returns the active slots of one coverage area, after checking that the
// area belongs to an approved, active trainer.
async function getCoverageAreaSlots(req, res) {
  const { coverageAreaId } = validate(slotsParamsSchema, req.params);

  // Make sure the area exists and belongs to an approved, active trainer
  const area = await pool.query(
    `SELECT ca.id, ca.area_name, ca.trainer_id
       FROM trainer_coverage_areas ca
       JOIN trainer_profiles tp ON tp.user_id = ca.trainer_id
       JOIN users u ON u.id = tp.user_id
      WHERE ca.id = $1
        AND tp.status = 'approved'
        AND u.is_active`,
    [coverageAreaId]
  );

  if (area.rowCount === 0) {
    return res.status(404).json({ error: 'Coverage area not found' });
  }

  const { rows } = await pool.query(
    `SELECT id, day_of_week, start_time, end_time, price
       FROM trainer_slots
      WHERE coverage_area_id = $1
        AND is_active
      ORDER BY day_of_week, start_time`,
    [coverageAreaId]
  );

  res.json({
    coverageArea: {
      id: area.rows[0].id,
      areaName: area.rows[0].area_name,
      trainerId: area.rows[0].trainer_id,
    },
    slots: rows.map((s) => ({
      id: s.id,
      dayOfWeek: s.day_of_week,
      startTime: s.start_time,
      endTime: s.end_time,
      price: Number(s.price),
    })),
  });
}

// Returns the trainers whose coverage area (center + radius_km) contains the given point.
// Distance is the haversine great-circle distance in km (earth radius 6371).
async function searchTrainer(req, res) {
  const { latitude, longitude } = validate(searchSchema, req.query);

  const user = await requireResident(req);
  const { rows } = await pool.query(


    //  AND ca.latitude IS NOT NULL AND ca.longitude IS NOT NULL AND ca.radius_km IS NOT NULL
        // AND d.distance_km <= ca.radius_km
        // how much distance km should be less
    `SELECT u.id, u.first_name, u.last_name, tp.bio,
            ca.id AS coverage_area_id, ca.area_name, ca.radius_km, d.distance_km
       FROM trainer_coverage_areas ca
       JOIN trainer_profiles tp ON tp.user_id = ca.trainer_id
       JOIN users u ON u.id = tp.user_id
      CROSS JOIN LATERAL (
            SELECT 6371 * 2 * asin(sqrt(
              power(sin(radians(ca.latitude - $1) / 2), 2) +
              cos(radians($1)) * cos(radians(ca.latitude)) *
              power(sin(radians(ca.longitude - $2) / 2), 2)
            )) AS distance_km
      ) d
      WHERE tp.status = 'approved'
        AND u.is_active
        AND ca.latitude IS NOT NULL AND ca.longitude IS NOT NULL AND ca.radius_km IS NOT NULL
        AND d.distance_km <= ca.radius_km
      ORDER BY d.distance_km`,
    [latitude, longitude]
  );


  // A trainer may have several matching areas; keep the nearest one per trainer.
  const seen = new Set();
  const trainers = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    trainers.push({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      bio: r.bio,
      coverageAreaId: r.coverage_area_id,
      areaName: r.area_name,
      distanceKm: Number(Number(r.distance_km).toFixed(2)),
    });
  }

  res.json({ trainers });
}
// Returns the location row for a booking: either the resident's saved one (locationId)
// or a newly saved one (location). Coverage is checked before anything is inserted.


// Creates a 'pending_payment' session that holds the slot for HOLD_MINUTES.
// A session blocks its slot while it is booked (requested..in_progress) or while
// a pending_payment hold has not expired; cancelled/declined/expired ones do not.

module.exports = { searchTrainer, getCoverageAreaSlots };
