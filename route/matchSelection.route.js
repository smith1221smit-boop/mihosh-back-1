const express = require('express');
const matchSelectionController = require('../controller/MatchSelection.controller.js');
const isPollingActiveController = require('../controller/isPollingactive.controller.js');

const requireAuth = require('../authMiddleware.js'); // your session auth
const { cacheMiddleware } = require('../middleware/cache.js');
const router = express.Router();



// Get polling status for a specific match
router.get('/:matchId/polling', requireAuth, cacheMiddleware(), isPollingActiveController.getPollingStatus);

// PATCH update polling status for a specific match inside a specific tournament & round
router.patch(
  '/:tournamentId/:roundId/:matchId/polling',
  requireAuth,
  isPollingActiveController.updatePollingStatus
);

// POST to select a match
router.post('/select', requireAuth, matchSelectionController.selectMatch);

// GET the currently selected match for a tournament & round
router.get('/:tournamentId/:roundId', requireAuth, cacheMiddleware(), matchSelectionController.getSelectedMatch);

// DELETE a match selection by matchId
router.delete('/match/:matchId', requireAuth, matchSelectionController.deleteMatchSelection);

// GET all selections for a tournament & round
router.get('/:tournamentId/:roundId/all', requireAuth, cacheMiddleware(), matchSelectionController.getAllSelections);

// GET all selected matches
router.get('/selected', requireAuth, matchSelectionController.getAllSelectedMatches);



module.exports = router;
