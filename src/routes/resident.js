const express = require('express');
// const { registerUser, loginUser, me } = require('../controllers/auth');
// const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/search', searchTrainer);

// Trainer routes: add once trainer signup is ready (/trainer/register, /trainer/login)


module.exports = router;
