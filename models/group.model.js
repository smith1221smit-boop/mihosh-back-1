// models/group.model.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const GroupSchema = new Schema({
  groupName: { type: String, required: true },
  tournamentId: { 
    type: Schema.Types.ObjectId,
    ref: 'Tournament',
    required: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  slots: [
    {
      team: {
        type: Schema.Types.ObjectId,
        ref: 'Team',
        required: true
      },
      slot: {
        type: Number,
        required: true
      }
    }
  ],
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Group', GroupSchema);
