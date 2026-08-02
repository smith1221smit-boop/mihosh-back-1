function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    console.log(`[auth] 401 no session -> ${req.method} ${req.originalUrl}`);
    return res.status(401).json({ message: "Not logged in" });
  }
  next();
}

module.exports = requireAuth;
