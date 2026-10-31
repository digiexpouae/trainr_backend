const express = require('express');
const { searchTrainer, getCoverageAreaSlots } = require('../controllers/resident');
const { listLocations, listBuildings, createLocation,updateLocation, deleteLocation } = require('../controllers/location');
const { requireAuth } = require('../middleware/auth');
const {createBooking}= require("../controllers/booking")

const router = express.Router();

router.get('/trainers/search',requireAuth, searchTrainer);
router.get('/coverage-areas/:coverageAreaId/slots',requireAuth, getCoverageAreaSlots);

// Resident addresses: list saved ones, list approved buildings, save a new address.
router.get('/locations', requireAuth, listLocations);
router.get('/buildings', requireAuth, listBuildings);
router.post('/bookings',requireAuth, createBooking)
router.post('/locations', requireAuth, createLocation);
router.put('/location/:id',requireAuth,updateLocation)
router.delete('/locations/:id',requireAuth,deleteLocation)

// Trainer routes: add once trainer signup is ready (/trainer/register, /trainer/login)






module.exports = router;
