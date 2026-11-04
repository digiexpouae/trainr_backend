const validate = require('../utils/validate');
const AppError = require('../utils/AppError');
const { registerUserSchema } = require('../validators/auth');
const auth = require('../services/auth');

// Phone OTP runs on the client (Firebase SDK). The client sends the resulting
// Firebase ID token in the Authorization header (Bearer). Express 5 forwards
// rejected promises to the error handler.

function getBearerToken(req) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AppError(401, 'Missing or malformed Authorization header');
  }
  return token;
}

async function registerUser(req, res) {
  const profile = validate(registerUserSchema, req.body);
  const decoded = await auth.verifyPhoneToken(getBearerToken(req));
  const user = await auth.registerResident(decoded, profile);
  res.status(201).json({ user });
}

async function loginUser(req, res) {
  const decoded = await auth.verifyPhoneToken(getBearerToken(req));
  const user = await auth.loginResident(decoded);
  res.json({ user });
}

async function me(req, res) {
  const row = await auth.findByFirebaseUid(req.user.uid);
  if (!row) throw new AppError(404, 'User not registered');
  res.json({ user: auth.toPublicUser(row) });
}

module.exports = { registerUser, loginUser, me };
