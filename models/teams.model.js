// models/teams.model.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const PlayerSchema = new Schema({
  playerName: { type: String, required: true },
  playerId: { type: String },
  photo: { type: String },
  hiddenBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
});

const TeamSchema = new Schema({
  teamFullName: { type: String, required: true },
  teamTag: { type: String, required: true, unique: true }, // creates its own unique index
  logo: { type: String },
  teamFlag: { type: String },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, // owner; null = legacy/unclaimed team
  hiddenBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  players: [PlayerSchema],
}, { timestamps: true });

TeamSchema.index({ teamFullName: 1 });
TeamSchema.index({ hiddenBy: 1 });
TeamSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Team', TeamSchema);