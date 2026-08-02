const User = require('../models/User.model.js');
const config = require('../config');
const crypto = require('crypto');

// --- CREATE USER (Admin protected, auto-login) ---
const createUser = async (req, res) => {
  try {
    const { username, email, password, adminAuth, isAdmin } = req.body;

    if (adminAuth !== config.ADMIN_CODE) {
      return res.status(403).json({ message: "Invalid admin authentication code" });
    }

    if (!isAdmin) {
      return res.status(403).json({ message: "Not authorized to create user" });
    }

const existingUser = await User.findOne({ email }).maxTimeMS(5000);
    if (existingUser) return res.status(400).json({ message: "User already exists" });

    const user = new User({ username, email, password, isAdmin: !!isAdmin });
    await user.save(); // hash password

    // store userId in session
   req.session.userId = user._id;
req.session.save(err => {
  if (err) return res.status(500).json({ message: err.message });
  res.status(200).json({
    user: {
      _id: user._id,
      username: user.username,
      email: user.email,
      isAdmin: user.isAdmin,
    },
  });
});
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};


// --- LOGIN USER ---
// --- LOGIN USER ---
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+relayToken').maxTimeMS(5000);
    if (!user) return res.status(400).json({ message: "User not found" });

    const isMatch = await user.matchPassword(password);
    if (!isMatch) return res.status(400).json({ message: "Invalid password" });

    // The desktop relay has no session cookie to present over its socket
    // connection, so it authenticates with this separate opaque token
    // instead of a raw userId. Issue one lazily on first login.
    if (!user.relayToken) {
      user.relayToken = crypto.randomBytes(32).toString('hex');
      await user.save();
    }

    req.session.userId = user._id;
    req.session.save(err => {
      if (err) {
        console.error('❌ Session save error:', err);
        return res.status(500).json({ message: err.message });
      }
      console.log(`[users] login ok user=${user._id} session=${req.sessionID}`);
      const setCookie = res.get('set-cookie');
      res.status(200).json({
        user: {
          _id: user._id,
          username: user.username,
          email: user.email,
          isAdmin: user.isAdmin,
          relayToken: user.relayToken,
        },
        sessionId: req.sessionID,
        sessionCookie: setCookie ? setCookie[0] : null,
      });
    });
  } catch (err) {
    console.error('MongoDB/User Error in loginUser:', err.message, err.stack);
    res.status(500).json({ message: 'Database error: ' + err.message });
  }
};


// --- LOGOUT USER ---
const logoutUser = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid"); // session cookie
    res.json({ message: "Logged out successfully" });
  });
};

// --- UPDATE USER (self or admin only; allowlisted fields; re-hashes via save) ---
const updateUser = async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: "Not logged in" });
    }

    const requester = await User.findById(req.session.userId).select('isAdmin').maxTimeMS(5000);
    const isSelf = req.session.userId.toString() === req.params.id;
    if (!isSelf && !requester?.isAdmin) {
      console.log(`[users] update denied requester=${req.session.userId} target=${req.params.id}`);
      return res.status(403).json({ message: "Not authorized to update this user" });
    }

    const user = await User.findById(req.params.id).maxTimeMS(5000);
    if (!user) return res.status(404).json({ message: "User not found" });

    const { username, email, password, isAdmin } = req.body;
    if (username !== undefined) user.username = username;
    if (email !== undefined) user.email = email;
    if (password !== undefined) user.password = password; // hashed by pre('save')
    if (isAdmin !== undefined && requester?.isAdmin) user.isAdmin = isAdmin; // only an admin may (re)grant admin

    await user.save();
    console.log(`[users] updated id=${user._id} by=${req.session.userId}`);

    const safeUser = user.toObject();
    delete safeUser.password;
    res.json(safeUser);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// --- DELETE USER (self or admin only) ---
const deleteUser = async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: "Not logged in" });
    }

    const requester = await User.findById(req.session.userId).select('isAdmin').maxTimeMS(5000);
    const isSelf = req.session.userId.toString() === req.params.id;
    if (!isSelf && !requester?.isAdmin) {
      console.log(`[users] delete denied requester=${req.session.userId} target=${req.params.id}`);
      return res.status(403).json({ message: "Not authorized to delete this user" });
    }

    const user = await User.findByIdAndDelete(req.params.id).maxTimeMS(5000);
    if (!user) return res.status(404).json({ message: "User not found" });
    console.log(`[users] deleted id=${req.params.id} by=${req.session.userId}`);
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

// --- GET ALL USERS (admin-only, passwords stripped) ---
const getAllUsers = async (req, res) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ message: "Not logged in" });
    }
    const requester = await User.findById(req.session.userId).select('isAdmin').maxTimeMS(5000);
    if (!requester?.isAdmin) {
      return res.status(403).json({ message: "Admin only" });
    }
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getCurrentUser = async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Not logged in" });
  }

  const user = await User.findById(req.session.userId).select("-password +relayToken").maxTimeMS(5000);
  if (!user) {
    console.log(`[users] /me: session userId=${req.session.userId} has no matching user`);
    return res.status(404).json({ message: "User not found" });
  }

  if (!user.relayToken) {
    user.relayToken = crypto.randomBytes(32).toString('hex');
    await user.save();
  }

  const setCookie = res.get('set-cookie');
  console.log(`[users] /me ok user=${user._id}`);
  res.json({ ...user.toObject(), sessionId: req.sessionID, sessionCookie: setCookie ? setCookie[0] : null });
};


module.exports = {
  createUser,
  loginUser,
  logoutUser,
  updateUser,
  deleteUser,
  getAllUsers,
  getCurrentUser
};
