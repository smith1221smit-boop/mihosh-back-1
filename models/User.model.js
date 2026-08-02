const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, default: false },
  // Opaque token the desktop relay presents to prove which user it belongs
  // to over the socket connection (which carries no session cookie).
  // select: false keeps it out of normal find()/findById() results so it
  // never leaks through getAllUsers or any other user's response.
  relayToken: { type: String, unique: true, sparse: true, select: false },
}, { timestamps: true });

// Hash password before saving.
// NOTE: this used to check this.isModified('pasword') (typo'd field name),
// which never matches a real path, so it was always false and this hook
// NEVER hashed anything — every password was saved to Mongo in plaintext.
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password.
// Also transparently upgrades any pre-existing plaintext row (saved under
// the bug above) to a real bcrypt hash on the next successful login,
// instead of requiring a separate migration/password reset.
userSchema.methods.matchPassword = async function(password) {
  const stored = this.password || '';
  const isBcryptHash = /^\$2[aby]\$/.test(stored);

  if (!isBcryptHash) {
    if (password !== stored) return false;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(password, salt);
    await this.save();
    return true;
  }

  return await bcrypt.compare(password, stored);
};

module.exports = mongoose.model('User', userSchema);
