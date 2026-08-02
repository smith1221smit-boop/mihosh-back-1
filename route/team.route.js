const express = require('express');
const router = express.Router();
const teamController = require('../controller/teams.controller.js');
const { cacheMiddleware, invalidateCacheMiddleware } = require('../middleware/cache.js');
const requireAuth = require('../authMiddleware.js');

// Reads stay public (any signed-in or anonymous caller can browse teams,
// with per-user hiddenBy filtering). Mutations require requireAuth AND,
// in the controller, ownership: only a team's creator (or an admin) can
// edit/delete it or its players. Legacy teams with no createdBy (created
// before per-user ownership existed) remain editable by anyone until
// claimed — see canMutateTeam() in teams.controller.js.

// Create a new team
router.post('/teams', requireAuth, invalidateCacheMiddleware(['cache:/api/teams', 'cache:/api/matches', 'cache:/api/groups']), teamController.createTeam);

// Get all teams
router.get('/teams', cacheMiddleware(), teamController.getAllTeams);

// Get a team by ID
router.get('/teams/:id', cacheMiddleware(), teamController.getTeamById);

// Update a team by ID
router.put('/teams/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/teams', `cache:/api/teams/${req.params.id}`, 'cache:/api/matches', 'cache:/api/groups']), teamController.updateTeam);

// Delete a team by ID
router.delete('/teams/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/teams', `cache:/api/teams/${req.params.id}`, 'cache:/api/matches', 'cache:/api/groups']), teamController.deleteTeam);

// Add a player to a team
router.post('/teams/:id/players', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/teams', `cache:/api/teams/${req.params.id}`, 'cache:/api/matches', 'cache:/api/groups']), teamController.addPlayerToTeam);

// Remove a player from a team by player subdocument ID
router.delete('/teams/:id/players/:playerId', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/teams', `cache:/api/teams/${req.params.id}`, 'cache:/api/matches', 'cache:/api/groups']), teamController.removePlayerFromTeam);

router.delete(
  "/teams/:id/players",
  requireAuth,
  invalidateCacheMiddleware((req) => ['cache:/api/teams', `cache:/api/teams/${req.params.id}`, 'cache:/api/matches', 'cache:/api/groups']),
  teamController.removeMultiplePlayersFromTeam
);

module.exports = router;
