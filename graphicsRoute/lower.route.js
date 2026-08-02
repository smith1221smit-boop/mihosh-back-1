const express = require('express');
const router = express.Router();
const { getSpecificData } = require('../graphicsController/lower.js');
const { cacheMiddleware } = require('../middleware/cache.js');

// GET /api/lowerData/:tournamentId/:roundId/:matchId
router.get(
  '/:tournamentId/:roundId/:matchId',
  cacheMiddleware(), // ✅ caches the lower data
  getSpecificData
);

module.exports = router;