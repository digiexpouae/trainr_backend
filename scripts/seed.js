// DEV ONLY: inserts a small set of test data so the booking API can be tried without a UI.
// Usage: npm run seed   (safe to run more than once)
// Log in as any seeded user with:  Authorization: Bearer dev-<firebase_uid>   (NODE_ENV=development)

require('dotenv').config();
const { Pool } = require('pg');

const url = new URL(process.env.DATABASE_URL);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

if (process.env.NODE_ENV === 'production' || !isLocal) {
  console.error(`Refusing to seed: host is "${url.hostname}". seed only runs against localhost.`);
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Returns the id of the row matching `where`, inserting `row` first if there is none.
async function findOrCreate(db, table, where, row) {
  const wKeys = Object.keys(where);
  const found = await db.query(
    `SELECT id FROM ${table} WHERE ${wKeys.map((k, i) => `${k} = $${i + 1}`).join(' AND ')}`,
    wKeys.map((k) => where[k])
  );
  if (found.rowCount > 0) return found.rows[0].id;

  const all = { ...where, ...row };
  const keys = Object.keys(all);
  const { rows } = await db.query(
    `INSERT INTO ${table} (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => all[k])
  );
  return rows[0].id;
}

async function upsertUser(db, { uid, first, last, phone, email, role }) {
  const { rows } = await db.query(
    `INSERT INTO users
       (firebase_uid, first_name, last_name, phone, email, role, accepted_terms_version, accepted_terms_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, now())
     ON CONFLICT (firebase_uid) DO UPDATE SET is_active = true
     RETURNING id`,
    [uid, first, last, phone, email, role]
  );
  return rows[0].id;
}

// Next calendar date (YYYY-MM-DD) that falls on the given weekday (0 = Sunday), today included.
function nextDateFor(dayOfWeek) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((dayOfWeek - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- users ---
    const adminId = await upsertUser(client, {
      uid: 'admin1', first: 'Test', last: 'Admin', phone: '+971500000001', email: 'admin@test.local', role: 'admin',
    });
    await client.query(
      `INSERT INTO admin_profiles (user_id, admin_role, two_factor_enabled)
       VALUES ($1, 'super_admin', false) ON CONFLICT (user_id) DO NOTHING`, [adminId]
    );

    const residentId = await upsertUser(client, {
      uid: 'resident1', first: 'Rita', last: 'Resident', phone: '+971500000002', email: 'resident@test.local', role: 'resident',
    });
    await client.query('INSERT INTO resident_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [residentId]);

    const trainerId = await upsertUser(client, {
      uid: 'trainer1', first: 'Tom', last: 'Trainer', phone: '+971500000003', email: 'trainer@test.local', role: 'trainer',
    });
    await client.query(
      `INSERT INTO trainer_profiles (user_id, bio, status)
       VALUES ($1, 'Seeded test trainer', 'approved')
       ON CONFLICT (user_id) DO UPDATE SET status = 'approved'`, [trainerId]
    );

    // --- buildings: one approved, one pending (to test the "not approved" failure) ---
    const goodBuildingId = await findOrCreate(client, 'building', { name: 'Marina Tower' }, {
      location: 'Dubai Marina', status: 'approved', created_by: adminId, approved_by: adminId,
    });
    const pendingBuildingId = await findOrCreate(client, 'building', { name: 'Pending Heights' }, {
      location: 'JLT', status: 'pending', created_by: adminId,
    });

    const goodTbId = await findOrCreate(client, 'trainer_buildings',
      { trainer_id: trainerId, building_id: goodBuildingId }, { status: 'approved', reviewed_by: adminId });
    const pendingTbId = await findOrCreate(client, 'trainer_buildings',
      { trainer_id: trainerId, building_id: pendingBuildingId }, { status: 'approved', reviewed_by: adminId });

    // --- coverage area: 5 km around Dubai Marina ---
    const areaId = await findOrCreate(client, 'trainer_coverage_areas',
      { trainer_id: trainerId, area_name: 'Dubai Marina' }, { latitude: 25.0805, longitude: 55.1403, radius_km: 5 });

    // --- slots ---
    const coverageSlot = await findOrCreate(client, 'trainer_slots',
      { trainer_id: trainerId, scope: 'coverage_area', coverage_area_id: areaId, day_of_week: 1, start_time: '18:00' },
      { end_time: '19:00', price: 150 });
    const buildingSlot = await findOrCreate(client, 'trainer_slots',
      { trainer_id: trainerId, scope: 'building', trainer_building_id: goodTbId, day_of_week: 3, start_time: '07:00' },
      { end_time: '08:00', price: 120 });
    const pendingBuildingSlot = await findOrCreate(client, 'trainer_slots',
      { trainer_id: trainerId, scope: 'building', trainer_building_id: pendingTbId, day_of_week: 5, start_time: '07:00' },
      { end_time: '08:00', price: 120 });

    // --- resident's saved locations ---
    const insideId = await findOrCreate(client, 'resident_locations',
      { resident_id: residentId, label: 'Home (inside coverage)' },
      { type: 'home', address: 'Marina Walk, Dubai Marina', latitude: 25.085, longitude: 55.145 });
    const outsideId = await findOrCreate(client, 'resident_locations',
      { resident_id: residentId, label: 'Office (outside coverage)' },
      { type: 'work', address: 'Corniche Rd, Abu Dhabi', latitude: 24.4539, longitude: 54.3773 });
    const buildingLocId = await findOrCreate(client, 'resident_locations',
      { resident_id: residentId, label: 'Marina Tower flat' },
      { type: 'building', address: 'Marina Tower, Dubai Marina', latitude: 25.0805, longitude: 55.1403, building_id: goodBuildingId });
    const pendingBuildingLocId = await findOrCreate(client, 'resident_locations',
      { resident_id: residentId, label: 'Pending Heights flat' },
      { type: 'building', address: 'Pending Heights, JLT', latitude: 25.0657, longitude: 55.1413, building_id: pendingBuildingId });

    await client.query('COMMIT');

    console.log(`
Seed done. Use these with "Authorization: Bearer <token>":
  resident token : dev-resident1   (user id ${residentId})
  trainer token  : dev-trainer1    (user id ${trainerId})
  admin token    : dev-admin1      (user id ${adminId})

Slots (sessionDate must fall on the slot's weekday):
  coverage slot ${coverageSlot}  Mon 18:00-19:00  -> try sessionDate ${nextDateFor(1)}
  building slot ${buildingSlot}  Wed 07:00-08:00  -> try sessionDate ${nextDateFor(3)}  (approved building)
  building slot ${pendingBuildingSlot}  Fri 07:00-08:00  -> try sessionDate ${nextDateFor(5)}  (building NOT approved)

Resident saved locations (locationId):
  ${insideId} inside coverage       ${outsideId} outside coverage
  ${buildingLocId} Marina Tower (approved) ${pendingBuildingLocId} Pending Heights (not approved)
Coverage area id: ${areaId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
