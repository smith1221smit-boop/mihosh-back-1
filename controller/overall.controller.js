const mongoose = require('mongoose');
const Match = require('../models/match.model');
const MatchData = require('../models/matchData.model');
const Round = require('../models/round.model');
const Tournament = require('../models/tournament.model');
const { getSocket } = require('../socket');

// Numeric player fields to aggregate (sum)
const NUMERIC_PLAYER_FIELDS = [
  'health',
  'healthMax',
  'liveState',
  'killNum',
  'killNumBeforeDie',
  'gotAirDropNum',
  'maxKillDistance',
  'damage',
  'heal',
  'killNumInVehicle',
  'killNumByGrenade',
  'AIKillNum',
  'BossKillNum',
  'rank',
  'inDamage',
  'headShotNum',
  'survivalTime',
  'driveDistance',
  'marchDistance',
  'assists',
  'outsideBlueCircleTime',
  'knockouts',
  'rescueTimes',
  'useSmokeGrenadeNum',
  'useFragGrenadeNum',
  'useBurnGrenadeNum',
  'useFlashGrenadeNum',
  'PoisonTotalDamage',
  'UseSelfRescueTime',
  'UseEmergencyCallTime',
  'contribution'
];

function sumNumericFields(target, source, fields) {
  for (const f of fields) {
    const a = Number(target[f] || 0);
    const b = Number(source[f] || 0);
    target[f] = a + b;
  }
}

// Build an initial player aggregate object based on incoming player doc
function buildInitialAggPlayer(p) {
  const base = {
    uId: p.uId || '',
    _id: p._id, // MongoDB player ObjectId
    playerName: p.playerName || '',
    playerOpenId: p.playerOpenId || '',
    picUrl: p.picUrl || '',
    showPicUrl: p.showPicUrl || '',
    character: p.character || '',
    isFiring: false,
    bHasDied: false,
    location: { x: 0, y: 0, z: 0 },
    health: 0,
    healthMax: 0,
    liveState: 0,
    killNum: 0,
    killNumBeforeDie: 0,
    playerKey: p.playerKey || '',
    gotAirDropNum: 0,
    maxKillDistance: 0,
    damage: 0,
    heal: 0,
    killNumInVehicle: 0,
    killNumByGrenade: 0,
    AIKillNum: 0,
    BossKillNum: 0,
    rank: 0,
    isOutsideBlueCircle: false,
    inDamage: 0,
    headShotNum: 0,
    survivalTime: 0,
    driveDistance: 0,
    marchDistance: 0,
    assists: 0,
    outsideBlueCircleTime: 0,
    knockouts: 0,
    rescueTimes: 0,
    useSmokeGrenadeNum: 0,
    useFragGrenadeNum: 0,
    useBurnGrenadeNum: 0,
    useFlashGrenadeNum: 0,
    PoisonTotalDamage: 0,
    UseSelfRescueTime: 0,
    UseEmergencyCallTime: 0,
    teamIdfromApi: p.teamIdfromApi || '',
    contribution: 0,
  };
  return base;
}

// Helper function to compute overall aggregated matchData for a round
// Helper: within a single match, a player's uId can appear multiple times as
// progressive snapshots (stats are cumulative, not deltas). Keep only the
// "final" snapshot — the one with the greatest survivalTime.
function dedupPlayersWithinMatch(players) {
  const map = new Map();
  for (const p of players || []) {
    const key = p.uId || '';
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...p });
      continue;
    }
    const currentSurvival = Number(current.survivalTime || 0);
    const incomingSurvival = Number(p.survivalTime || 0);
    if (incomingSurvival >= currentSurvival) {
      map.set(key, { ...p });
    }
  }
  return Array.from(map.values());
}

// Shared aggregation core — turns an array of already-resolved MatchData docs
// into standings. Used by both computeOverallMatchDataForRound (below) and
// Bulkpublic.controller.js's getOverallForRound, so the dashboard/live-socket
// path and the public bulk/overlay path always compute the exact same
// numbers instead of drifting apart via two hand-maintained implementations.
//
// Player aggregation is scoped PER TEAM (a Map on each aggTeam), not one map
// shared across every team in the round — a global map would silently merge
// one player's stats onto every team that happens to share their uId (see
// the cross-team playerId collision fixed in pubgApiMatchData.controller.js's
// uidToTeam building).
function aggregateOverallTeams(matchDataDocs) {
  // Deduplicate MatchData documents by matchId (there should only be one
  // per match, but if duplicates ever exist, keep the most recently updated one)
  const uniqueMatchDatasMap = new Map();
  for (const md of matchDataDocs || []) {
    const key = md.matchId.toString();
    const existingDoc = uniqueMatchDatasMap.get(key);
    if (
      !existingDoc ||
      (md.updatedAt && existingDoc.updatedAt && new Date(md.updatedAt) > new Date(existingDoc.updatedAt))
    ) {
      uniqueMatchDatasMap.set(key, md);
    }
  }
  const uniqueMatchDatas = Array.from(uniqueMatchDatasMap.values());

  // Deduplicate players within each match's teams by uId, keeping the final snapshot
  const deduplicatedMatchDatas = uniqueMatchDatas.map(md => ({
    ...md,
    teams: (md.teams || []).map(team => ({
      ...team,
      players: dedupPlayersWithinMatch(team.players),
    })),
  }));

  const teamsMap = new Map(); // key: teamId string -> aggregated team (players Map scoped per team)

  for (const md of deduplicatedMatchDatas) {
    const seenTeamIds = new Set();
    for (const team of md.teams || []) {
      const teamKey = team.teamId.toString();
      // Defensive: two teams[] subdocuments sharing a teamId within the
      // SAME MatchData would otherwise double-count placePoints/wwcd.
      if (seenTeamIds.has(teamKey)) {
        console.warn(`[aggregateOverallTeams] duplicate teamId ${teamKey} in matchData ${md._id} — skipping to avoid double-counting`);
        continue;
      }
      seenTeamIds.add(teamKey);

      if (!teamsMap.has(teamKey)) {
        teamsMap.set(teamKey, {
          teamId: team.teamId,
          teamName: team.teamName || '',
          teamTag: team.teamTag || '',
          teamLogo: team.teamLogo || '',
          slot: Number.isFinite(team.slot) ? team.slot : 0,
          placePoints: 0,
          wwcd: 0,
          matchIds: new Set(),  // track distinct matches this team appeared in
          players: new Map(),   // uId -> aggregated player, scoped to THIS team
        });
      }

      const aggTeam = teamsMap.get(teamKey);
      if (!aggTeam.teamName && team.teamName) aggTeam.teamName = team.teamName;
      if (!aggTeam.teamTag && team.teamTag) aggTeam.teamTag = team.teamTag;
      if (!aggTeam.teamLogo && team.teamLogo) aggTeam.teamLogo = team.teamLogo;

      if (Number.isFinite(team.slot)) {
        aggTeam.slot = Math.min(aggTeam.slot || team.slot, team.slot);
      }

      aggTeam.placePoints += Number(team.placePoints || 0);
      // Prefer the real computed rank; only fall back to the placePoints
      // heuristic for older docs written before `rank` was persisted.
      const isWinner = team.rank === 1 || (!team.rank && Number(team.placePoints || 0) === 10);
      if (isWinner) {
        aggTeam.wwcd += 1;
      }

      aggTeam.matchIds.add(md.matchId.toString());

      // Aggregate players per-team by uId (sum each match's final stats across matches)
      for (const p of team.players || []) {
        const pKey = p.uId || p._id.toString();
        if (!aggTeam.players.has(pKey)) {
          aggTeam.players.set(pKey, buildInitialAggPlayer(p));
        }
        const aggPlayer = aggTeam.players.get(pKey);

        if (p.playerName) aggPlayer.playerName = p.playerName;
        if (p.picUrl) aggPlayer.picUrl = p.picUrl;
        if (p.showPicUrl) aggPlayer.showPicUrl = p.showPicUrl;
        if (p.character) aggPlayer.character = p.character;
        if (p.playerOpenId) aggPlayer.playerOpenId = p.playerOpenId;
        if (p.uId) aggPlayer.uId = p.uId;
        if (p.teamIdfromApi) aggPlayer.teamIdfromApi = p.teamIdfromApi;

        sumNumericFields(aggPlayer, p, NUMERIC_PLAYER_FIELDS);
      }
    }
  }

  // Convert to arrays, sort teams by slot asc, expose matchesPlayed
  const aggregatedTeams = Array.from(teamsMap.values()).map(t => ({
    teamId: t.teamId,
    teamName: t.teamName,
    teamTag: t.teamTag,
    teamLogo: t.teamLogo,
    slot: t.slot || 0,
    placePoints: t.placePoints,
    wwcd: t.wwcd,
    matchesPlayed: t.matchIds.size,
    players: Array.from(t.players.values()),
  })).sort((a, b) => (a.slot || 0) - (b.slot || 0));

  // Final safety net: no duplicate uId within a team's players
  for (const t of aggregatedTeams) {
    t.players = Array.from(new Map(t.players.map(p => [p.uId, p])).values());
  }

  return aggregatedTeams;
}

const computeOverallMatchDataForRound = async (tournamentId, roundId, matchId, userId) => {
  // Verify round exists (skip ownership for public routes)
  const round = await Round.findOne({ _id: roundId, tournamentId, ...(userId && { createdBy: userId }) });
  if (!round) throw new Error('Round not found');

  // Verify match exists (skip ownership for public routes) — matchId is only
  // used for this existence/ownership check now, not to filter which matches
  // count toward standings: standings are always the FULL round total (see
  // aggregateOverallTeams), matching Bulkpublic.controller.js's behavior.
  const targetMatch = await Match.findOne({ _id: matchId, tournamentId, roundId, ...(userId && { userId }) });
  if (!targetMatch) throw new Error('Match not found');

  // Fetch all matches for this tournament/round
  const matches = await Match.find({ tournamentId, roundId, ...(userId && { userId }) }, { _id: 1, matchNo: 1 }).sort({ matchNo: 1 }).lean();
  if (!matches || matches.length === 0) {
    return [];
  }

  const matchIds = matches.map(m => m._id);

  // Ensure matchData exists for each match (create if missing to follow current pattern)
  const existing = await MatchData.find({ matchId: { $in: matchIds }, ...(userId && { userId }) }).select('_id matchId').lean();
  const existingMap = new Map(existing.map(md => [md.matchId.toString(), md._id]));

  // Required lazily (not at module top level): matchData.controller.js also
  // requires this file (for computeOverallMatchDataForRound), and a
  // top-level circular require here previously left createMatchDataForMatchDoc
  // resolved to undefined depending on which module loaded first — silently
  // skipping MatchData creation (and that match's points) for any match that
  // never got a MatchData doc. Requiring it here, after both modules have
  // finished loading, always gets the real function.
  const { createMatchDataForMatchDoc } = require('./matchData.controller');

  for (const m of matchIds) {
    if (!existingMap.has(m.toString())) {
      try {
        await createMatchDataForMatchDoc(m);
      } catch (e) {
        console.warn('Could not create MatchData for match', m.toString(), e?.message || e);
      }
    }
  }

  // Load all matchData after attempting creation
  const matchDatas = await MatchData.find({ matchId: { $in: matchIds }, ...(userId && { userId }) }).lean();

  return aggregateOverallTeams(matchDatas);
};

// GET overall aggregated matchData for a round in a tournament
// Response mirrors matchData structure: { teams: [ { teamId, teamName, teamTag, teamLogo, slot, placePoints, players: [...] } ] }
const getOverallMatchDataForRound = async (req, res) => {
  try {
    const userId = req.session && req.session.userId;

    const { tournamentId, roundId, matchId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(tournamentId) || !mongoose.Types.ObjectId.isValid(roundId) || !mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({ error: 'Invalid tournamentId, roundId, or matchId' });
    }

    const aggregatedTeams = await computeOverallMatchDataForRound(tournamentId, roundId, matchId, userId);

    // Emit overall data via socket for real-time updates — scoped to this
    // tournament/round's room (was a global io.emit(), leaking every
    // tournament's standings to every connected socket).
    try {
      const io = getSocket();
      // Required lazily to avoid a load-order cycle with matchData.controller.js
      const { ROOM } = require('../socket/comsock.js');
      const room = ROOM(tournamentId, roundId);
      console.log(`[socket] overallDataUpdate -> ${room}`);
      io.to(room).emit('overallDataUpdate', { tournamentId, roundId, matchId, teams: aggregatedTeams, createdAt: new Date() });
    } catch (socketError) {
      console.warn('Failed to emit overall data via socket:', socketError.message);
    }

    return res.json({ tournamentId, roundId, matchId, ...(userId && { userId }), teams: aggregatedTeams, createdAt: new Date() });
  } catch (error) {
    console.error('Error generating overall matchData:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getOverallMatchDataForRound,
  computeOverallMatchDataForRound,
  aggregateOverallTeams,
};
