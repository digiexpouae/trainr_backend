// DEV ONLY: wipes the public schema and re-runs every migration from scratch.
// Usage: npm run db:reset
// While the schema is still changing you can edit migrations/001_*.sql freely and reset.
// Once real data exists, stop using this and add numbered migrations instead.

require('dotenv').config();
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const url = new URL(process.env.DATABASE_URL);
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

if (process.env.NODE_ENV === 'production' || !isLocal) {
  console.error(`Refusing to reset: host is "${url.hostname}". db:reset only runs against localhost.`);
  process.exit(1);
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    console.log(`Reset database "${decodeURIComponent(url.pathname.slice(1))}"`);
  } finally {
    await pool.end();
  }
  execFileSync(process.execPath, [path.join(__dirname, '..', 'migrate.js')], { stdio: 'inherit' });
})().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
