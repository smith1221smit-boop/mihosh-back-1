const mongoose = require('mongoose');

const matchSelectionSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      required: true
    },
    roundId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Round',
      required: true
    },
    matchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
      required: true
    },
    isSelected: {
      type: Boolean,
      default: false
    },
    isPollingActive: { // <-- new field
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
     userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } // <-- owner (session user)
  },
  { versionKey: false }
);

// Middleware to clean up match selections when referenced documents are deleted
matchSelectionSchema.pre('remove', async function(next) {
  // This will be called when a MatchSelection document is removed
  // But we need to handle cascade deletion from parent documents
  next();
});

// Static method to clean up selections when a tournament is deleted
matchSelectionSchema.statics.cleanupByTournament = async function(tournamentId) {
  return this.deleteMany({ tournamentId });
};

// Static method to clean up selections when a round is deleted
matchSelectionSchema.statics.cleanupByRound = async function(roundId) {
  return this.deleteMany({ roundId });
};

// Static method to clean up selections when a match is deleted
matchSelectionSchema.statics.cleanupByMatch = async function(matchId) {
  return this.deleteMany({ matchId });
};

module.exports = mongoose.models.MatchSelection || mongoose.model('MatchSelection', matchSelectionSchema);
