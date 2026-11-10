const admin = require('../config/firebase');
const AppError = require('../utils/AppError');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
     throw new AppError(401,'Missing or malformed Authorization header' )

  }
  // for development
if (process.env.NODE_ENV === 'development' && token.startsWith('dev-')) {
    req.user = { uid: token.slice(4), phone_number: '+923001234567' };
    return next();
  }

  try {
    // checkRevoked=true rejects tokens issued before revokeRefreshTokens (logout)
    req.user = await admin.auth().verifyIdToken(token, true);
    next();
  } catch (err) {
         throw new AppError(401,'Invalid or expired token' )
  }
}

module.exports = { requireAuth };
