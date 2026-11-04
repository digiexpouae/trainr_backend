const admin = require('../config/firebase');
const { pool, withTransaction } = require('../config/db');
const AppError = require('../utils/AppError');

// Unique constraints on "users" -> message shown when an insert violates them.
const DUPLICATE_MESSAGES = {
  users_firebase_uid_key: 'Account already registered. Please log in.',
  users_phone_key: 'Phone number already registered. Please log in.',
  users_email_key: 'Email already in use',
};

const toPublicUser = (row) => ({
  id: row.id,
  firstName: row.first_name,
  lastName: row.last_name,
  phone: row.phone,
  email: row.email,
  role: row.role,
});

// Checks a Firebase ID token from phone OTP sign-in and returns its claims.
async function verifyPhoneToken(idToken) {
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }
  if (decoded.firebase?.sign_in_provider !== 'phone' || !decoded.phone_number) {
    throw new AppError(401, 'Token was not issued by phone OTP sign-in');
  }
  return decoded;
}

async function findByFirebaseUid(uid) {
  const { rows } = await pool.query('SELECT * FROM users WHERE firebase_uid = $1', [uid]);
  return rows[0] || null;
}

// For routes behind requireAuth: returns the active resident making the request, or throws 403.
async function requireResident(req) {
  const user = await findByFirebaseUid(req.user.uid);
  if (!user || user.role !== 'resident') throw new AppError(403, 'Only residents can access this');
  if (!user.is_active) throw new AppError(403, 'Account is deactivated');
  return user;
}

// Creates the users row and its resident_profiles row atomically.
async function registerResident(decoded, { firstName, lastName, email }) {
  try {
    const row = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO users
           (firebase_uid, phone, first_name, last_name, email, role,
            accepted_terms_version, accepted_terms_at)
         VALUES ($1, $2, $3, $4, $5, 'resident', true, now())
         RETURNING *`,
        [decoded.uid, decoded.phone_number, firstName, lastName, email ?? null]
      );
      await db.query('INSERT INTO resident_profiles (user_id) VALUES ($1)', [rows[0].id]);
      return rows[0];
    });
    return toPublicUser(row);
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError(409, DUPLICATE_MESSAGES[err.constraint] || 'Already registered');
    }
    throw err;
  }
}

// Returns the registered resident for a verified token, or throws 404/403.
async function loginResident(decoded) {

  const row = await findByFirebaseUid(decoded.uid);
 if (!row || row.role !== 'resident') {
    if (row) logger.warn(`Role mismatch: uid=${decoded.uid} has role=${row.role}, tried resident login`);
    throw new AppError(401, 'Invalid credentials or account not found.');
  }

  if (!row.is_active) throw new AppError(403, 'Account is deactivated');
  return toPublicUser(row);
}

module.exports = { verifyPhoneToken, findByFirebaseUid, requireResident, registerResident, loginResident, toPublicUser };
