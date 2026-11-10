const validate = require('../utils/validate');
const AppError = require('../utils/AppError');
const { sendSuccess, sendCreated } = require('../utils/response');
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
  sendCreated(res, { message: 'Registered successfully', data: user });
}

async function loginUser(req, res) {
  const decoded = await auth.verifyPhoneToken(getBearerToken(req));
  const user = await auth.loginResident(decoded);
  sendSuccess(res, { message: 'Logged in successfully', data: user });
}

async function me(req, res) {
  const row = await auth.findByFirebaseUid(req.user.uid);
  if (!row) throw new AppError(404, 'User not registered');
  sendSuccess(res, { message: 'Profile fetched successfully', data: auth.toPublicUser(row) });
}

async function logout(req, res) {
  // Dev tokens (see middleware/auth.js) have no Firebase user to revoke.
  const isDevToken =
    process.env.NODE_ENV === 'development' && getBearerToken(req).startsWith('dev-');
  if (!isDevToken) await auth.logout(req.user.uid);
  sendSuccess(res, { message: 'Logged out' });
}

module.exports = { registerUser, loginUser, me, logout };
