require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorMiddleware } = require('./middleware/error');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());

// Stripe signs the exact raw bytes, so this must come before express.json() and the rate limit.
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  require('./controllers/payment').stripeWebhook
);

app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/resident', require('./routes/resident'));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  require('./jobs/expirePendingPayments').startExpirePendingPayments();
});
