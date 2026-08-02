// routes/match.routes.js
const express = require('express');
const router = express.Router();
const matchController = require('../controller/match.controller.js');
const requireAuth = require('../authMiddleware.js'); // ✅ import middleware
const { cacheMiddleware, invalidateCacheMiddleware } = require('../middleware/cache.js');

// Create a match inside specific tournament and round
router.post(
  '/tournaments/:tournamentId/rounds/:roundId/matches',
  requireAuth,
  invalidateCacheMiddleware((req) => [
    `cache:/api/tournaments/${req.params.tournamentId}/matches`,
    `cache:/api/rounds/${req.params.roundId}/matches`,
    `cache:/api/tournaments/${req.params.tournamentId}/rounds/${req.params.roundId}/matches`,
  ]),
  matchController.createMatchInRoundInTournament
);

// Get match by ID
router.get(
  '/matches/:id',
  requireAuth,
  cacheMiddleware(),
  matchController.getMatchById
);

// Get all matches in a tournament
router.get(
  '/tournaments/:tournamentId/matches',
  requireAuth,
  cacheMiddleware(),
  matchController.getMatchesByTournamentId
);

// Get all matches in a round
router.get(
  '/rounds/:roundId/matches',
  requireAuth,
  cacheMiddleware(),
  matchController.getMatchesByRoundId
);

// Get matches by tournament AND round
router.get(
  '/tournaments/:tournamentId/rounds/:roundId/matches',
  requireAuth,
  cacheMiddleware(),
  matchController.getMatchesByTournamentAndRound
);

// Update a match
router.put(
  '/tournaments/:tournamentId/rounds/:roundId/matches/:id',
  requireAuth,
  invalidateCacheMiddleware((req) => [
    `cache:/api/matches/${req.params.id}`,
    `cache:/api/tournaments/${req.params.tournamentId}/matches`,
    `cache:/api/rounds/${req.params.roundId}/matches`,
    `cache:/api/tournaments/${req.params.tournamentId}/rounds/${req.params.roundId}/matches`,
  ]),
  matchController.updateMatch
);

// Delete a match
router.delete(
  '/tournaments/:tournamentId/rounds/:roundId/matches/:id',
  requireAuth,
  invalidateCacheMiddleware((req) => [
    `cache:/api/matches/${req.params.id}`,
    `cache:/api/tournaments/${req.params.tournamentId}/matches`,
    `cache:/api/rounds/${req.params.roundId}/matches`,
    `cache:/api/tournaments/${req.params.tournamentId}/rounds/${req.params.roundId}/matches`,
  ]),
  matchController.deleteMatch
);

module.exports = router;
