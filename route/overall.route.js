const express = require('express');
const router = express.Router();

const requireAuth = require('../authMiddleware.js');
const { cacheMiddleware } = require('../middleware/cache.js');
const { getOverallMatchDataForRound } = require('../controller/overall.controller.js');

// GET overall aggregated match data for a given tournament and round up to a specific match
// Mirrors matchData response structure but aggregated across matches up to the specified match
router.get(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/overall',
  requireAuth,
  cacheMiddleware(3, req => `round:${req.params.tournamentId}:${req.params.roundId}`),
  getOverallMatchDataForRound
);

module.exports = router;
