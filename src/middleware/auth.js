const admin = require('../config/firebase');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
console.log("scheme",scheme,"token",token)
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  // for development
if (process.env.NODE_ENV === 'development' && token.startsWith('dev-')) {
    req.user = { uid: token.slice(4), phone_number: '+923001234567' };
    return next();
  }

  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
