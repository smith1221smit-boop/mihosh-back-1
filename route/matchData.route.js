const express = require('express');
const router = express.Router();

const matchDataController = require('../controller/matchData.controller.js');
const requireAuth = require('../authMiddleware.js');
const { cacheMiddleware } = require('../middleware/cache.js');



// Get
router.get(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata',
  requireAuth,
  cacheMiddleware(3, req => `match:${req.params.matchId}`),
  matchDataController.getMatchDataByMatchId
);

// Public get
router.get(
  '/public/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata',
  cacheMiddleware(3, req => `match:${req.params.matchId}`),
  matchDataController.getMatchDataByMatchId
);

// Live players in this match with no roster match right now (picUrl/name
// unresolved) — powers the "unmatched players" panel so operators can spot
// and fix a bad roster UID during the match instead of it silently failing.
router.get(
  '/matchdata/:matchId/unmatched-players',
  requireAuth,
  matchDataController.getUnmatchedPlayersForMatch
);

// Update player: include teamId
// PATCH /.../matchdata/:matchDataId/team/:teamId/player/:playerId



// Delete matchData
router.delete(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata/:matchDataId',
  requireAuth,
  matchDataController.deleteMatchDataById
);


router.patch(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata/:matchDataId/team/:teamId/points',
  requireAuth,
  matchDataController.updateTeamPoints
);


router.patch(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata/:matchDataId/team/:teamId/player/:playerId/stats',
  requireAuth,
  matchDataController.updatePlayerStats
);

// Bulk team players update (e.g., toggle all died)
router.patch(
  '/tournament/:tournamentId/round/:roundId/match/:matchId/matchdata/:matchDataId/team/:teamId/bulk',
  requireAuth,
  matchDataController.updateTeamPlayersBulkStats
);

// Replace players in a specific team for a match
router.put(
  '/matchdata/:matchDataId/team/:teamId/replace',
  requireAuth,
  matchDataController.updatePlayerByIdInMatchData
);

router.post(
  '/matchdata/:matchDataId/team/:teamId/player/add',
  requireAuth,
  matchDataController.addPlayersToTeamInMatchData
);

router.delete(
  '/matchdata/:matchDataId/team/:teamId/players/remove',
  requireAuth,
  matchDataController.removePlayersFromTeamInMatchData
);

module.exports = router;
