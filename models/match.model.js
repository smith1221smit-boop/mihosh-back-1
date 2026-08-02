const mongoose = require('mongoose');
const { Schema } = mongoose;

const matchSchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true },
  matchNo: { type: Number, required: true },
  time: { type: String, required: true },
  map: { type: String, required: true },
  groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Group' }],
   userId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // ✅ new
});

module.exports = mongoose.models.Match || mongoose.model('Match', matchSchema);
