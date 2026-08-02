const express = require('express');
const router = express.Router();
const groupController = require('../controller/group.controller.js');
const requireAuth = require('../authMiddleware.js');
const { cacheMiddleware, invalidateCacheMiddleware } = require('../middleware/cache.js');

// Create group in a tournament
router.post('/tournaments/:tournamentId/groups', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/tournaments/' + req.params.tournamentId + '/groups', 'cache:/api/teams']), groupController.createGroup);

// Get all groups in a tournament
router.get('/tournaments/:tournamentId/groups', requireAuth, cacheMiddleware(), groupController.getAllGroups);

// Get a specific group by ID inside a tournament
router.get('/tournaments/:tournamentId/groups/:id', requireAuth, cacheMiddleware(), groupController.getGroupById);

// Update a group in a tournament
router.put('/tournaments/:tournamentId/groups/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/tournaments/' + req.params.tournamentId + '/groups', 'cache:/api/tournaments/' + req.params.tournamentId + '/groups/' + req.params.id, 'cache:/api/teams']), groupController.updateGroup);

// Delete a group in a tournament
router.delete('/tournaments/:tournamentId/groups/:id', requireAuth, invalidateCacheMiddleware((req) => ['cache:/api/tournaments/' + req.params.tournamentId + '/groups', 'cache:/api/tournaments/' + req.params.tournamentId + '/groups/' + req.params.id, 'cache:/api/teams']), groupController.deleteGroup);

module.exports = router;
