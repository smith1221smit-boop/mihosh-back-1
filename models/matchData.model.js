const mongoose = require('mongoose');
const { Schema } = mongoose;

//
// Player Stats Schema
//
const playerStatsSchema = new Schema({
  uId: String,
  playerName: String,
  playerOpenId: String,
  picUrl: String,
  showPicUrl: String,
  character: { type: String, default: 'None' },
  isFiring: { type: Boolean, default: false },
  bHasDied: { type: Boolean, default: false },
  location: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    z: { type: Number, default: 0 }
  },
  health: { type: Number, default: 0 },
  healthMax: { type: Number, default: 0 },
  liveState: { type: Number, default: 0 },
  killNum: { type: Number, default: 0 },
  killNumBeforeDie: { type: Number, default: 0 },
  playerKey: { type: String, default: '' },
  gotAirDropNum: { type: Number, default: 0 },
  maxKillDistance: { type: Number, default: 0 },
  damage: { type: Number, default: 0 },
  killNumInVehicle: { type: Number, default: 0 },
  killNumByGrenade: { type: Number, default: 0 },
  AIKillNum: { type: Number, default: 0 },
  BossKillNum: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
  isOutsideBlueCircle: { type: Boolean, default: false },
  inDamage: { type: Number, default: 0 },
  heal: { type: Number, default: 0 },
  headShotNum: { type: Number, default: 0 },
  survivalTime: { type: Number, default: 0 },
  driveDistance: { type: Number, default: 0 },
  marchDistance: { type: Number, default: 0 },
  assists: { type: Number, default: 0 },
  outsideBlueCircleTime: { type: Number, default: 0 },
  knockouts: { type: Number, default: 0 },
  rescueTimes: { type: Number, default: 0 },
  useSmokeGrenadeNum: { type: Number, default: 0 },
  useFragGrenadeNum: { type: Number, default: 0 },
  useBurnGrenadeNum: { type: Number, default: 0 },
  useFlashGrenadeNum: { type: Number, default: 0 },
  PoisonTotalDamage: { type: Number, default: 0 },
  UseSelfRescueTime: { type: Number, default: 0 },
  UseEmergencyCallTime: { type: Number, default: 0 },
  teamIdfromApi: String,
  teamId: { type: Number, default: 0 },
  teamName: { type: String, default: '' },
  contribution: { type: Number, default: 0 }
}, { _id: true }); // ✅ default _id for each player

//
// Team Match Data Schema with slot field
//
const teamMatchDataSchema = new Schema({
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    required: true
  },
  teamName: { type: String, default: '' },
    teamTag: { type: String, default: '' }, // <-- add this line
    teamLogo: { type: String, default: '' }, // <-- add this line
  slot: { type: Number, required: true }, // ✅ slot from Group
  placePoints: { type: Number, default: 0 },
  players: {
    type: [playerStatsSchema],
    validate: {
      validator: function (val) {
        return val.length <= 4;
      },
      message: 'A team can have a maximum of 4 players.'
    }
  }
}, { _id: true }); // ✅ default _id for each team

//
// Match Data Schema
//
const matchDataSchema = new Schema({
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Match',
    required: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  teams: [teamMatchDataSchema], // Each team includes slot now
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('MatchData', matchDataSchema);
