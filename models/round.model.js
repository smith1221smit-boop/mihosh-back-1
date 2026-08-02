const mongoose = require('mongoose');

const roundSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  roundName: { type: String, required: true },
  apiEnable: { type: Boolean, default: false },
  day: { type: String },
  groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Group' }],
  selectedMatch: {
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

// Hard DB-level guarantee: a user can never have more than one round
// with apiEnable: true at the same time, no matter what the app code does.
roundSchema.index(
  { createdBy: 1, apiEnable: 1 },
  { unique: true, partialFilterExpression: { apiEnable: true } }
);

module.exports = mongoose.model('Round', roundSchema);