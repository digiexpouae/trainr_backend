# Trainr Backend

REST API for Trainr, an app where residents book personal-trainer sessions. Built with Node.js, Express 5, PostgreSQL and Firebase Authentication (phone OTP).

## Requirements
- Node.js 20+
- PostgreSQL
- A Firebase project with **Phone** sign-in enabled

## Setup
1. Install dependencies:
   ```
   npm install
   ```
2. Create a `.env` file:
   ```
   DATABASE_URL=postgres://user:password@localhost:5432/trainr
   NODE_ENV=development
   PORT=3000
   FIREBASE_SERVICE_ACCOUNT_PATH=./your-service-account.json
   ```
3. Download a service account key from Firebase Console → Project settings → Service accounts, and point `FIREBASE_SERVICE_ACCOUNT_PATH` at it. Keep this file private. It is git-ignored.
4. Create the tables and optional sample data:
   ```
   npm run migrate
   npm run seed
   ```
5. Start the server:
   ```
   npm run dev
   ```
   Check `http://localhost:3000/health`.

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | Start with nodemon |
| `npm start` | Start with node |
| `npm run migrate` | Run migrations |
| `npm run seed` | Insert seed data |
| `npm run db:reset` | Reset the database (destructive) |

## API
Base URL: `http://localhost:3000`. Protected routes need `Authorization: Bearer <Firebase ID token>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | No | Health check |
| POST | `/api/auth/user/register` | Bearer | Register a resident |
| POST | `/api/auth/user/login` | Bearer | Log in a resident |
| GET | `/api/auth/me` | Bearer | Current user |
| GET | `/api/resident/trainers/search` | Bearer | Search trainers |
| GET | `/api/resident/coverage-areas/:coverageAreaId/slots` | Bearer | Slots for a coverage area |
| GET | `/api/resident/locations` | Bearer | List saved locations |
| POST | `/api/resident/locations` | Bearer | Create a location |
| PUT | `/api/resident/location/:id` | Bearer | Update a location |
| DELETE | `/api/resident/locations/:id` | Bearer | Delete a location |
| GET | `/api/resident/buildings` | Bearer | List buildings |
| POST | `/api/resident/bookings` | Bearer | Book a slot (held for 10 minutes) |
| POST | `/api/resident/sessions/:id/pay` | Bearer | Start payment, returns Stripe `clientSecret` |
| POST | `/api/payments/webhook` | Stripe signature | Stripe events (not for apps) |

## Payments (Stripe)
1. Resident books a slot. The session is `pending_payment`.
2. App calls `POST /api/resident/sessions/:id/pay` and pays with the returned `clientSecret` using Stripe's SDK.
3. Stripe calls `/api/payments/webhook`. Only a signed event moves the session to `requested`.

Add to `.env`: `STRIPE_SECRET_KEY=sk_test_...` and `STRIPE_WEBHOOK_SECRET=whsec_...`. Run `npm run migrate` for migration 003.

Test locally: `stripe listen --forward-to localhost:3000/api/payments/webhook`, then pay with test card `4242 4242 4242 4242`. A declined card is `4000 0000 0000 0002`.

## Getting a token for testing
1. In Firebase Console → Authentication → Sign-in method → Phone, add a test phone number and code. Under Settings → SMS region policy, allow the country.
2. Serve the test page: `npx serve public`
3. Open `http://localhost:<port>/firebase-auth.html`, enter the test number, then the code. Copy the ID token.
4. Use it in Postman as a Bearer token (Authorization tab). Every route, including register and login, reads it from the `Authorization: Bearer <token>` header.

ID tokens expire after about an hour. Sign out on the page and sign in again for a new one.

## Project structure
```
src/
  server.js        app setup and error handling
  routes/          route definitions
  controllers/     request handlers
  services/        business logic
  validators/      zod schemas
  middleware/      auth
  config/          db and firebase
  utils/           helpers
migrations/        SQL schema
scripts/           db-reset, seed
public/            Firebase sign-in test page
```

## Security
- Never commit `.env` or the Firebase service account JSON.
- Always use HTTPS in production, and do not log tokens.
- Restrict CORS to your frontend's domain before deploying.
