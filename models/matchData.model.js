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
  // `min: 0` on every stat/counter below documents that none of these
  // should ever legitimately go negative, and backstops any FUTURE write
  // path that uses `.save()`/`.create()` (Mongoose only runs schema
  // validators there by default — NOT on `updateOne`/`findOneAndUpdate`/
  // `bulkWrite` unless `runValidators: true` is explicitly passed, which
  // the existing update-based write paths don't). The actual fixes for the
  // two known negative-value sources are the explicit application-level
  // clamps in pubgApiMatchData.controller.js's ingestion and
  // matchData.controller.js's updatePlayerStats — this is a backstop on
  // top of those, not a substitute for them. Identifiers (teamId) and
  // coordinates (location) are deliberately left unclamped.
  health: { type: Number, default: 0, min: 0 },
  healthMax: { type: Number, default: 0, min: 0 },
  liveState: { type: Number, default: 0, min: 0 },
  killNum: { type: Number, default: 0, min: 0 },
  killNumBeforeDie: { type: Number, default: 0, min: 0 },
  playerKey: { type: String, default: '' },
  gotAirDropNum: { type: Number, default: 0, min: 0 },
  maxKillDistance: { type: Number, default: 0, min: 0 },
  damage: { type: Number, default: 0, min: 0 },
  killNumInVehicle: { type: Number, default: 0, min: 0 },
  killNumByGrenade: { type: Number, default: 0, min: 0 },
  AIKillNum: { type: Number, default: 0, min: 0 },
  BossKillNum: { type: Number, default: 0, min: 0 },
  rank: { type: Number, default: 0, min: 0 },
  isOutsideBlueCircle: { type: Boolean, default: false },
  inDamage: { type: Number, default: 0, min: 0 },
  heal: { type: Number, default: 0, min: 0 },
  headShotNum: { type: Number, default: 0, min: 0 },
  survivalTime: { type: Number, default: 0, min: 0 },
  driveDistance: { type: Number, default: 0, min: 0 },
  marchDistance: { type: Number, default: 0, min: 0 },
  assists: { type: Number, default: 0, min: 0 },
  outsideBlueCircleTime: { type: Number, default: 0, min: 0 },
  knockouts: { type: Number, default: 0, min: 0 },
  rescueTimes: { type: Number, default: 0, min: 0 },
  useSmokeGrenadeNum: { type: Number, default: 0, min: 0 },
  useFragGrenadeNum: { type: Number, default: 0, min: 0 },
  useBurnGrenadeNum: { type: Number, default: 0, min: 0 },
  useFlashGrenadeNum: { type: Number, default: 0, min: 0 },
  PoisonTotalDamage: { type: Number, default: 0, min: 0 },
  UseSelfRescueTime: { type: Number, default: 0, min: 0 },
  UseEmergencyCallTime: { type: Number, default: 0, min: 0 },
  teamIdfromApi: String,
  teamId: { type: Number, default: 0 },
  teamName: { type: String, default: '' },
  contribution: { type: Number, default: 0, min: 0 }
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
  placePoints: { type: Number, default: 0, min: 0 },
  // Real computed placement (1 = winner), persisted alongside placePoints
  // so WWCD/standings can key off the actual rank instead of inferring a
  // win from a magic placePoints value that manual overrides can break.
  rank: { type: Number, default: 0, min: 0 },
  // Set when an operator manually corrects placePoints via updateTeamPoints.
  // While true, the live-poll scoring loop leaves placePoints/rank alone
  // instead of silently overwriting the correction on the next tick.
  placePointsLocked: { type: Boolean, default: false },
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
