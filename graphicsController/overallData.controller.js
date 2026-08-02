const Tournament = require('../models/tournament.model.js');
const Round = require('../models/round.model.js');
const Match = require('../models/match.model.js');
const MatchData = require('../models/matchData.model.js');
const { getSocket } = require('../socket.js');
const { ROOM } = require('../socket/comsock.js');
const { encode } = require('@msgpack/msgpack');

const NUMERIC_PLAYER_FIELDS = [
  'killNum','killNumBeforeDie','damage','headShotNum','killNumInVehicle','killNumByGrenade',
  'AIKillNum','BossKillNum','survivalTime','assists','knockouts','rescueTimes','driveDistance',
  'marchDistance','outsideBlueCircleTime','inDamage','heal','useSmokeGrenadeNum','useFragGrenadeNum',
  'useBurnGrenadeNum','useFlashGrenadeNum','PoisonTotalDamage','UseSelfRescueTime','UseEmergencyCallTime',
  'gotAirDropNum','maxKillDistance','contribution'
];

const getOverallSlimData = async (req, res) => {
  try {
    const { tournamentId, roundId } = req.params;

    // ── Fetch tournament and round ─────────────────────────────
    const tournament = await Tournament.findOne({ _id: tournamentId }).lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    const round = await Round.findOne({ _id: roundId, tournamentId }).lean();
    if (!round) return res.status(404).json({ error: 'Round not found' });

    // ── Fetch matches and match data ───────────────────────────
    const matches = await Match.find({ roundId: round._id }).sort({ matchNo: 1 }).lean();
    const matchIds = matches.map(m => m._id);
    const allMatchDatas = await MatchData.find({ matchId: { $in: matchIds } }).lean();
    const matchDataByMatchId = new Map(allMatchDatas.map(md => [md.matchId.toString(), md]));

    const teamMap = new Map();

    // ── Aggregate per-team, per-player stats ──────────────────
    for (const match of matches) {
      const md = matchDataByMatchId.get(match._id.toString());
      if (!md) continue;

      for (const team of md.teams || []) {
        if (!team.players || team.players.length === 0) continue;
        const teamKey = team.teamId?.toString();
        if (!teamKey) continue;

        // Aggregate numeric player stats
        const playerTotals = {};
        for (const p of team.players) {
          const uId = p.uId?.toString() || p._id?.toString();
          if (!playerTotals[uId]) {
            playerTotals[uId] = {};
            for (const field of NUMERIC_PLAYER_FIELDS) playerTotals[uId][field] = 0;
          }
          for (const field of NUMERIC_PLAYER_FIELDS) playerTotals[uId][field] += p[field] ?? 0;
        }

        if (!teamMap.has(teamKey)) {
          // First match for this team
          const entry = {
            teamId: teamKey,
            teamName: team.teamName || '',
            teamTag: team.teamTag || '',
            teamLogo: team.teamLogo || '',
            slot: team.slot ?? 0,
            matchCount: 1,
            totalPlacePoints: team.placePoints ?? 0,
            playerStats: {}
          };
          for (const p of team.players) {
            const uId = p.uId?.toString() || p._id?.toString();
            entry.playerStats[uId] = {
              uId,
              playerName: p.playerName || '',
              picUrl: p.picUrl || '',
              ...playerTotals[uId]
            };
          }
          teamMap.set(teamKey, entry);
        } else {
          // Subsequent match
          const entry = teamMap.get(teamKey);
          entry.matchCount += 1;
          entry.totalPlacePoints += team.placePoints ?? 0;
          for (const p of team.players) {
            const uId = p.uId?.toString() || p._id?.toString();
            if (!entry.playerStats[uId]) {
              entry.playerStats[uId] = { uId, playerName: p.playerName || '', picUrl: p.picUrl || '' };
              for (const field of NUMERIC_PLAYER_FIELDS) entry.playerStats[uId][field] = 0;
            }
            for (const field of NUMERIC_PLAYER_FIELDS) {
              entry.playerStats[uId][field] += playerTotals[uId][field] || 0;
            }
          }
        }
      }
    }

    // ── Build final teams array with totals ───────────────────
    const teams = Array.from(teamMap.values()).map(entry => {
      const totalKills = Object.values(entry.playerStats).reduce((sum, p) => sum + (p.killNum || 0), 0);
      const totalPoints = entry.totalPlacePoints + totalKills;

      return {
        teamId: entry.teamId,
        teamName: entry.teamName,
        teamTag: entry.teamTag,
        teamLogo: entry.teamLogo,
        slot: entry.slot,
        matchCount: entry.matchCount,
        totalPlacePoints: entry.totalPlacePoints,
        totalKills,
        totalPoints,
        players: Object.values(entry.playerStats)
      };
    }).sort((a, b) =>
      b.totalPoints !== a.totalPoints
        ? b.totalPoints - a.totalPoints
        : b.totalKills - a.totalKills
    );

    // ── Construct payload ─────────────────────────────────────
    const payload = {
      tournament: {
        _id: tournament._id,
        tournamentName: tournament.tournamentName || '',
        torLogo: tournament.torLogo || '',
        primaryColor: tournament.primaryColor || '#FFD000',
        secondaryColor: tournament.secondaryColor || '#333333',
        overlayBg: tournament.overlayBg || ''
      },
      round: {
        _id: round._id,
        roundName: round.roundName || '',
        apiEnable: round.apiEnable ?? false
      },
      matchCount: matches.length,
      teams
    };

    // ── Encode payload using MsgPack ─────────────────────────
    const encodedPayload = encode(payload);

    // ── Emit over socket as binary — scoped to this tournament/round's
    // room (was a global io.emit(), leaking data across tournaments) ──
    try {
      const io = getSocket();
      const room = ROOM(tournamentId, roundId);
      console.log(`[socket] overallDataUpdate -> ${room}`);
      io.to(room).emit('overallDataUpdate', encodedPayload);
    } catch (err) {
      console.warn('Socket emit failed:', err.message);
    }

    // ── Optionally return binary response over HTTP ─────────
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(encodedPayload);

  } catch (error) {
    console.error('Error fetching overall slim data:', error);
    return res.status(500).json({ error: 'Failed to fetch overall slim data' });
  }
};

module.exports = { getOverallSlimData };