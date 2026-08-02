const express = require('express');
const router = express.Router();
const tournamentController = require('../controller/tournament.controller.js');
const requireAuth = require('../authMiddleware.js'); // your session auth
const { cacheMiddleware, invalidateCacheMiddleware } = require('../middleware/cache.js');

// Specific routes first
// Put '/' route BEFORE '/:id'
router.get('/', requireAuth, cacheMiddleware(), tournamentController.getTournaments);
router.post('/', requireAuth, tournamentController.createTournament);
router.get('/name/:name', requireAuth, cacheMiddleware(), tournamentController.getTournamentByName);
router.get('/rounds/:tournamentId', requireAuth, cacheMiddleware(), tournamentController.getRoundsByTournamentId);
router.get('/:id', requireAuth, cacheMiddleware(), tournamentController.getTournamentById);
router.put('/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/tournaments', 'cache:/api/tournaments/' + req.params.id, 'cache:/api/public/tournaments/' + req.params.id, 'cache:/api/tournaments/' + req.params.id + '/rounds']), tournamentController.updateTournament);
router.delete('/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/tournaments', 'cache:/api/tournaments/' + req.params.id, 'cache:/api/public/tournaments/' + req.params.id, 'cache:/api/tournaments/' + req.params.id + '/rounds']), tournamentController.deleteTournament);

module.exports = router;
