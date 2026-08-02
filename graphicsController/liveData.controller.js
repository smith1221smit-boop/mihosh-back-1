const Tournament = require('../models/tournament.model.js');
const Round = require('../models/round.model.js');
const Match = require('../models/match.model.js');
const MatchData = require('../models/matchData.model.js');
const { getSocket } = require('../socket.js');
const { ROOM } = require('../socket/comsock.js');
const msgpack = require('@msgpack/msgpack');

const getLiveSlimData = async (req, res) => {
  try {
    const { tournamentId, roundId, matchId } = req.params;

    const tournament = await Tournament.findOne({ _id: tournamentId }).lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const round = await Round.findOne({ _id: roundId, tournamentId }).lean();
    if (!round) return res.status(404).json({ error: 'Round not found' });

    const match = await Match.findOne({ _id: matchId, roundId }).lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const matchData = await MatchData.findOne({ matchId: match._id }).lean();

    const slimTeams = (matchData?.teams || []).map(team => ({
      _id: team._id,
      teamId: team.teamId,
      teamName: team.teamName || '',
      teamTag: team.teamTag || '',
      teamLogo: team.teamLogo || '',
      slot: team.slot ?? 0,
      placePoints: team.placePoints ?? 0,
    players: (team.players || []).map(p => ({
  _id: p._id,
  uId: p.uId ?? '',
  playerName: p.playerName || '',
  playerOpenId: p.playerOpenId || '',

  picUrl: p.picUrl || p.photo || '',
  showPicUrl: '',
  character: 'None',

  // Core state
  health: p.health ?? 0,
  healthMax: p.healthMax ?? 0,
  liveState: p.liveState ?? 0,
  bHasDied: p.bHasDied ?? false,
  isFiring: false,

  // Position
  location: p.location || { x: 0, y: 0, z: 0 },

  // Combat
  killNum: p.killNum ?? 0,
  killNumBeforeDie: p.killNumBeforeDie ?? 0,
  damage: p.damage ?? 0,
  headShotNum: p.headShotNum ?? 0,

  // Extra kills
  killNumInVehicle: p.killNumInVehicle ?? 0,
  killNumByGrenade: p.killNumByGrenade ?? 0,
  AIKillNum: p.AIKillNum ?? 0,
  BossKillNum: p.BossKillNum ?? 0,

  // Survival
  survivalTime: p.survivalTime ?? 0,
  rank: p.rank ?? 0,
  assists: p.assists ?? 0,
  knockouts: p.knockouts ?? 0,
  rescueTimes: p.rescueTimes ?? 0,

  // Movement
  driveDistance: p.driveDistance ?? 0,
  marchDistance: p.marchDistance ?? 0,

  // Zone
  isOutsideBlueCircle: p.isOutsideBlueCircle ?? false,
  outsideBlueCircleTime: p.outsideBlueCircleTime ?? 0,
  inDamage: p.inDamage ?? 0,

  // Utility
  heal: p.heal ?? 0,
  useSmokeGrenadeNum: p.useSmokeGrenadeNum ?? 0,
  useFragGrenadeNum: p.useFragGrenadeNum ?? 0,
  useBurnGrenadeNum: p.useBurnGrenadeNum ?? 0,
  useFlashGrenadeNum: p.useFlashGrenadeNum ?? 0,

  // Special
  gotAirDropNum: p.gotAirDropNum ?? 0,
  maxKillDistance: p.maxKillDistance ?? 0,
  PoisonTotalDamage: p.PoisonTotalDamage ?? 0,
  UseSelfRescueTime: p.UseSelfRescueTime ?? 0,
  UseEmergencyCallTime: p.UseEmergencyCallTime ?? 0,

  // IDs
  playerKey: p.playerKey || '',
  teamIdfromApi: p.teamIdfromApi || '',

  // Derived (from team)
  teamId: team.slot ?? 0,
  teamName: team.teamName || '',

  contribution: p.contribution ?? 0,
})),
    }));

    const payload = {
      tournament: {
        _id: tournament._id,
        tournamentName: tournament.tournamentName || '',
        torLogo: tournament.torLogo || '',
        primaryColor: tournament.primaryColor || '#FFD000',
        secondaryColor: tournament.secondaryColor || '#333333',
        overlayBg: tournament.overlayBg || '',
      },
      round: {
        _id: round._id,
        roundName: round.roundName || '',
        apiEnable: round.apiEnable ?? false,
      },
      match: {
        _id: match._id,
        matchName: match.matchName || '',
        matchNo: match.matchNo ?? 0,
        map: match.map || '',
      },
      matchData: {
        _id: matchData?._id || null,
        teams: slimTeams,
      },
    };

    // ✅ Encode using MsgPack
    const encodedPayload = msgpack.encode(payload);

    // ✅ Emit binary via socket — scoped to this tournament/round's room so
    // other tournaments' overlays never receive this payload (was a global
    // io.emit() before, leaking every user's live data to every socket).
    try {
      const io = getSocket();
      const room = ROOM(tournamentId, roundId);
      console.log(`[socket] liveMatchUpdate -> ${room}`);
      io.to(room).emit('liveMatchUpdate', encodedPayload);
    } catch (socketError) {
      console.warn('Socket emit failed:', socketError.message);
    }

    // ✅ Send binary response
    res.setHeader('Content-Type', 'application/msgpack');
    return res.send(encodedPayload);

  } catch (error) {
    console.error('Error fetching live slim data:', error);
    return res.status(500).json({ error: 'Failed to fetch live slim data' });
  }
};

module.exports = { getLiveSlimData };