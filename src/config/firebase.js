const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.resolve(
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    './trainr-app-44f5c-firebase-adminsdk-fbsvc-b5847d3722.json'
);

admin.initializeApp({
  credential: admin.credential.cert(require(serviceAccountPath)),
});

module.exports = admin;
