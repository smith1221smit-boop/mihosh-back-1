const mongoose = require('mongoose');
const Schema = mongoose.Schema; // ✅ add this

const tournamentSchema = new mongoose.Schema({
  tournamentName: { type: String, required: true },
  torLogo: { type: String },
  day: { type: String },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  overlayBg: { type: String },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // Assuming userId is required

});

module.exports = mongoose.model('Tournament', tournamentSchema);
