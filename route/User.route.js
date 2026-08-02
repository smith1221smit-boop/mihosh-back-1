const express = require('express');
const router = express.Router();
const {
  createUser,
  loginUser,
  logoutUser,
  updateUser,
  deleteUser,
  getAllUsers,
  getCurrentUser
} = require('../controller/User.controller.js');
const { cacheMiddleware } = require('../middleware/cache.js');
const requireAuth = require('../authMiddleware.js');

// Admin protected user creation
router.post('/register', createUser);
router.get("/me", getCurrentUser); // session check route
// Login & logout
router.post('/login', loginUser);
router.post('/logout', logoutUser);

// CRUD — self-or-admin / admin-only checks are enforced in the controller,
// requireAuth here just rejects unauthenticated calls before we touch the DB.
router.put('/:id', requireAuth, updateUser);
router.delete('/:id', requireAuth, deleteUser);
router.get('/', requireAuth, getAllUsers);

module.exports = router;
