const express = require('express');
const { registerUser, loginUser, me, logout } = require('../controllers/auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/user/register', registerUser);
router.post('/user/login', loginUser);

// Trainer routes: add once trainer signup is ready (/trainer/register, /trainer/login)

router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, logout);

module.exports = router;
