const MatchData = require('../models/matchData.model');
const Match = require('../models/match.model');
const Round = require('../models/round.model');
const Tournament = require('../models/tournament.model');
const Group = require('../models/group.model.js');
const { getSocket } = require('../socket.js');
const mongoose = require('mongoose');
const { computeOverallMatchDataForRound } = require('./overall.controller');
const { encodeMsgpack } = require('../utils/msgpackCodec');

// ─── Shared player-template builder ───────────────────────────────────────────
// Was previously copy-pasted 3x (create / replace / add) with small drifts
// between copies — e.g. the replace/add copies were missing the `teamId`
// field entirely, which the original create path always set. Centralizing
// it means all three paths always produce an identically-shaped player.
function buildFreshPlayer(sourcePlayer, teamSlot, teamName) {
  return {
    uId: sourcePlayer.playerId || '',
    _id: sourcePlayer._id,
    playerName: sourcePlayer.playerName,
    playerOpenId: sourcePlayer.playerOpenId || '',
    picUrl: sourcePlayer.photo || sourcePlayer.picUrl || '',
    showPicUrl: '',
    character: 'None',
    isFiring: false,
    bHasDied: false,
    location: { x: 0, y: 0, z: 0 },
    health: 0,
    healthMax: 0,
    liveState: 0,
    killNum: 0,
    killNumBeforeDie: 0,
    playerKey: '',
    gotAirDropNum: 0,
    maxKillDistance: 0,
    damage: 0,
    killNumInVehicle: 0,
    killNumByGrenade: 0,
    AIKillNum: 0,
    BossKillNum: 0,
    rank: 0,
    isOutsideBlueCircle: false,
    inDamage: 0,
    heal: 0,
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
    teamIdfromApi: '',
    teamId: teamSlot,
    teamName: teamName || '',
    contribution: 0,
  };
}

// ─── Small ID helpers ──────────────────────────────────────────────────────
// Endpoints in this file have historically matched a "team" two different
// ways: some by the MatchData subdocument's own `_id`, others by the
// `teamId` field (which references the original Team document). That
// inconsistency is a likely cause of intermittent "Team not found" errors
// depending on which id the caller happens to send. matchesTeamId() and the
// $or clauses below accept either, so callers aren't punished for it.
function toObjectIdOrNull(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null;
}
function matchesTeamId(team, teamId) {
  return String(team._id) === String(teamId) || String(team.teamId) === String(teamId);
}

// ─── In-memory per-resource update lock (unchanged behavior, shared helper) ──
const updateLocks = new Map();
function acquireLock(lockKey) {
  if (updateLocks.has(lockKey)) return false;
  updateLocks.set(lockKey, true);
  return true;
}
function releaseLock(lockKey) {
  updateLocks.delete(lockKey);
}

// Fire the secondary "overall standings" recompute + broadcast without
// making the caller wait on it — it's an aggregate view, not the primary
// resource being mutated, so there's no correctness reason to block the
// HTTP response on it. Shaves the slowest part of every write off the
// response time the client actually sees.
//
// Also pushes to the PUBLIC overlay room (`round:${tournamentId}:${roundId}`,
// see PublicThemeRenderer.tsx) — msgpack-encoded binary, same event names
// (liveMatchUpdate/overallDataUpdate) the automatic API live-tick path
// (pubgApiMatchData.controller.js) already uses. Manual edits used to reach
// the overlay via comsock.js's MongoDB change-stream watcher (deleted this
// session); this is what replaces that for the manual-entry path
// specifically. `matchData` is the caller's already-updated document —
// passing it through avoids a redundant re-fetch.
function emitOverallUpdateAsync(io, matchId, userId, matchData) {
  console.log(`[socket] emitOverallUpdateAsync called matchId=${matchId} userId=${userId} hasMatchData=${!!matchData}`);
  Match.findById(matchId).lean()
    .then(match => {
      if (!match) {
        console.warn(`[socket] emitOverallUpdateAsync: no Match found for matchId=${matchId} — nothing emitted`);
        return;
      }
      const room = `round:${match.tournamentId}:${match.roundId}`;
      const socketsInRoom = io.sockets.adapter.rooms.get(room)?.size || 0;
      console.log(`[socket] emitOverallUpdateAsync: room=${room} has ${socketsInRoom} socket(s) currently joined`);

      if (matchData) {
        io.to(room).emit('liveMatchUpdate', encodeMsgpack({ ...matchData, matchId: String(matchId) }));
        console.log(`[socket] liveMatchUpdate -> ${room} match=${matchId}`);
      }

      return computeOverallMatchDataForRound(match.tournamentId, match.roundId, matchId, userId)
        .then(overallTeams => {
          const overallPayload = {
            tournamentId: match.tournamentId,
            roundId: match.roundId,
            matchId,
            teams: overallTeams,
            createdAt: new Date(),
          };
          console.log(`[socket] overallDataUpdate -> user:${userId} + ${room} match=${matchId}`);
          io.to(`user:${userId}`).emit('overallDataUpdate', overallPayload);
          io.to(room).emit('overallDataUpdate', encodeMsgpack(overallPayload));
        });
    })
    .catch(err => console.warn('Failed to emit overall data update:', err.message));
}

const createMatchDataForMatchDoc = async (matchOrId) => {
  try {
    if (!matchOrId) throw new Error('No matchId provided');
    const matchId = typeof matchOrId === 'object' && matchOrId._id ? matchOrId._id : matchOrId;

    // Read-only fetch — .lean() skips document hydration since we only
    // ever read from `match` here, we never save() it.
    const match = await Match.findById(matchId).populate({
      path: 'groups',
      populate: {
        path: 'slots.team',
        populate: { path: 'players' },
      }
    }).lean();

    if (!match) throw new Error('Match not found');

    let teams = (match.groups || []).flatMap(group =>
      (group.slots || [])
        .filter(slot => slot.team)
        .map(slot => ({
          slot: slot.slot,
          teamId: slot.team._id,
          teamLogo: slot.team.logo || '',
          teamName: slot.team.teamFullName || slot.team.teamName || '',
          teamTag: slot.team.teamTag || '',
          players: (slot.team.players || []).slice(0, 4)
            .map(player => buildFreshPlayer(player, slot.slot, slot.team.teamFullName || '')),
        }))
    );

    teams.sort((a, b) => a.slot - b.slot);

    const matchData = new MatchData({
      matchId: match._id,
      userId: match.userId,
      teams
    });

    await matchData.save();
    return matchData;
  } catch (error) {
    console.error('Error creating MatchData:', error);
    throw error;
  }
};

// Reconciles existing MatchData docs against a Group's current slots.
// createMatchDataForMatchDoc only ever runs once, at match-creation time —
// if a team is added to (or swapped into) a group slot afterwards, the
// matches that already exist for that group never learn about it. This
// walks every such match and patches in what's missing, without touching
// already-recorded live stats (placePoints, per-player fields) for teams
// that are unchanged.
const syncMatchDataTeamsForGroup = async (groupId) => {
  try {
    const group = await Group.findById(groupId).populate({
      path: 'slots.team',
      populate: { path: 'players' },
    }).lean();
    if (!group) return;

    const matches = await Match.find({ groups: group._id }).select('_id').lean();
    if (!matches.length) return;

    const matchDatas = await MatchData.find({ matchId: { $in: matches.map(m => m._id) } });

    for (const matchData of matchDatas) {
      let changed = false;

      for (const slot of group.slots || []) {
        if (!slot.team) continue;

        const existing = matchData.teams.find(
          t => String(t.teamId) === String(slot.team._id) || t.slot === slot.slot
        );

        const freshPlayers = (slot.team.players || []).slice(0, 4)
          .map(player => buildFreshPlayer(player, slot.slot, slot.team.teamFullName || ''));

        if (!existing) {
          // Brand new team in this slot — add it.
          matchData.teams.push({
            slot: slot.slot,
            teamId: slot.team._id,
            teamLogo: slot.team.logo || '',
            teamName: slot.team.teamFullName || slot.team.teamName || '',
            teamTag: slot.team.teamTag || '',
            players: freshPlayers,
          });
          changed = true;
        } else if (String(existing.teamId) !== String(slot.team._id)) {
          // Slot's team was swapped — replace identity/roster, drop stale stats.
          existing.teamId = slot.team._id;
          existing.slot = slot.slot;
          existing.teamLogo = slot.team.logo || '';
          existing.teamName = slot.team.teamFullName || slot.team.teamName || '';
          existing.teamTag = slot.team.teamTag || '';
          existing.players = freshPlayers;
          changed = true;
        } else {
          // Same team — only refresh display metadata, never touch live stats/roster.
          const teamName = slot.team.teamFullName || slot.team.teamName || '';
          const teamTag = slot.team.teamTag || '';
          const teamLogo = slot.team.logo || '';
          if (existing.slot !== slot.slot) { existing.slot = slot.slot; changed = true; }
          if (existing.teamName !== teamName) { existing.teamName = teamName; changed = true; }
          if (existing.teamTag !== teamTag) { existing.teamTag = teamTag; changed = true; }
          if (existing.teamLogo !== teamLogo) { existing.teamLogo = teamLogo; changed = true; }
        }
      }

      if (changed) {
        matchData.markModified('teams');
        await matchData.save();
      }
    }
  } catch (error) {
    console.error('Error syncing MatchData teams for group:', error);
  }
};

// Get MatchData by matchId (user-scoped)
const getMatchDataByMatchId = async (req, res) => {
  try {
    const { matchId } = req.params;
    let userId = req.session && req.session.userId;

    if (!userId) {
      const match = await Match.findById(matchId).lean();
      if (!match) return res.status(404).json({ error: 'Match not found' });
      const round = await Round.findById(match.roundId).lean();
      if (!round) return res.status(404).json({ error: 'Round not found' });
      const tournament = await Tournament.findById(round.tournamentId).lean();
      if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
      userId = tournament.createdBy;
    }

    let match = await Match.findOne({ _id: matchId, userId }).lean();

    if (!match) {
      const possible = await Match.findById(matchId).lean();
      if (!possible) return res.status(404).json({ error: 'Match not found' });

      // A match that's already owned by someone else must never be
      // silently reassigned to the current caller — only backfill
      // ownership for genuinely unowned (legacy) matches.
      if (possible.userId) {
        return res.status(404).json({ error: 'Match not found or not yours' });
      }

      const round = await Round.findOne({ _id: possible.roundId, createdBy: userId }).lean();
      if (!round) return res.status(404).json({ error: 'Match not found or not yours' });

      await Match.updateOne({ _id: possible._id, userId: { $exists: false } }, { $set: { userId } });
      match = { ...possible, userId };
    }

    let matchData = await MatchData.findOne({ matchId: match._id, userId }).lean();

    if (!matchData) {
      try {
        const created = await createMatchDataForMatchDoc(match._id);
        if (created && !created.userId) {
          created.userId = userId;
          await created.save();
        }
        matchData = created ? created.toObject() : null;
      } catch (e) {
        return res.json({ _id: null, matchId: match._id, userId, teams: [] });
      }
    }

    if (!matchData) return res.json({ _id: null, matchId: match._id, userId, teams: [] });

    res.json(matchData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// === Update Team Points & Emit via Socket ===
const updateTeamPoints = async (req, res) => {
  const { matchId, matchDataId, teamId } = req.params;
  const lockKey = `${matchDataId}-${teamId}-points`;

  if (!acquireLock(lockKey)) {
    console.log('Team points update already in progress for:', lockKey);
    return res.status(429).json({ error: 'Update already in progress, please wait' });
  }

  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = req.session.userId;

    const { placePoints, rank, unlock } = req.body;
    if (typeof placePoints !== 'number') {
      return res.status(400).json({ error: 'placePoints must be a number' });
    }

    const teamObjId = toObjectIdOrNull(teamId);
    if (!teamObjId) return res.status(400).json({ error: 'Invalid teamId' });

    // Manually correcting placePoints locks it so the live-poll scoring
    // loop (pubgApiMatchData.controller.js) doesn't silently overwrite the
    // correction on its next tick. Pass `unlock: true` to hand control
    // back to auto-scoring. `rank` is optional — pass it alongside
    // placePoints when correcting a team whose real placement also needs
    // fixing (WWCD/standings key off rank, not placePoints).
    const setFields = {
      'teams.$[team].placePoints': placePoints,
      'teams.$[team].placePointsLocked': unlock !== true,
    };
    if (typeof rank === 'number') {
      setFields['teams.$[team].rank'] = rank;
    }

    // Ownership + team-location + write, all in ONE atomic round trip —
    // replaces the old "fetch Match, fetch MatchData, then $set with
    // arrayFilters" 3-query sequence with a single findOneAndUpdate whose
    // own filter already proves ownership (matchData.userId === req.session.userId).
    const result = await MatchData.findOneAndUpdate(
      { _id: matchDataId, matchId, userId },
      { $set: setFields },
      {
        new: true,
        arrayFilters: [{ $or: [{ 'team._id': teamObjId }, { 'team.teamId': teamObjId }] }],
      }
    ).lean();

    if (!result) return res.status(404).json({ error: 'MatchData or Team not found, or not yours' });

    const io = getSocket();
    console.log(`[socket] matchDataUpdated -> user:${userId} team=${teamId}`);
    io.to(`user:${userId}`).emit('matchDataUpdated', { matchDataId, teamId, changes: { placePoints } });

    // Respond immediately — the client doesn't need to wait on the
    // secondary "overall standings" recompute below.
    res.json({ message: 'Team placePoints updated', matchDataId, teamId, changes: { placePoints } });

    emitOverallUpdateAsync(io, matchId, userId, result);
  } catch (error) {
    console.error('Error updating team points:', error);
    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
};

// === Update a single player's stats (PATCH) ===
//
// WHY THIS WAS FAILING INTERMITTENTLY:
// The old implementation did: findById(matchDataId) -> mutate the JS object
// -> matchData.save(). Mongoose documents carry an optimistic-concurrency
// version key (`__v`) under the hood, and .save() throws a VersionError if
// the document changed in the DB between your findById and your save. In a
// live-scoring tool, operators fire off several PATCH requests for
// different players/stats within milliseconds of each other — exactly the
// pattern that triggers this. Two of `updateTeamPoints` and
// `updateTeamPlayersBulkStats` already had `updateLocks` guarding them, but
// this endpoint had none, and even a lock only prevents identical duplicate
// requests, not two *different* concurrent PATCHes racing on the same
// document's version.
//
// FIX: replaced the read-modify-save cycle with a single atomic
// findOneAndUpdate using arrayFilters to reach the exact player field(s).
// Mongo handles the write atomically at the document level, so there's
// nothing to version-conflict on, and it's also strictly fewer round trips
// (was 3 auth/lookup queries + 1 save; now 1 query total).
const updatePlayerStats = async (req, res) => {
  try {
    const { matchId, matchDataId, teamId, playerId } = req.params;
    const updateData = req.body;

    if (!matchId || !matchDataId || !teamId || !playerId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized - No session' });
    }
    const userId = req.session.userId;

    const teamObjId = toObjectIdOrNull(teamId);
    const playerObjId = toObjectIdOrNull(playerId);
    if (!teamObjId || !playerObjId) {
      return res.status(400).json({ error: 'Invalid teamId or playerId' });
    }

    // NOTE: 'killNum' is intentionally NOT in this list. It used to be
    // present here *and* handled separately via killNumChange below — if a
    // caller sent both in the same payload, whichever code path ran last
    // silently won, and the two could fight each other across requests.
    // It now has exactly one path: absolute value OR delta, never both.
    const allowedFields = [
      'playerName', 'playerOpenId', 'picUrl', 'showPicUrl', 'character', 'isFiring',
      'bHasDied', 'health', 'healthMax', 'liveState', 'killNumBeforeDie',
      'playerKey', 'gotAirDropNum', 'maxKillDistance', 'damage', 'killNumInVehicle',
      'killNumByGrenade', 'AIKillNum', 'BossKillNum', 'rank', 'isOutsideBlueCircle',
      'inDamage', 'headShotNum', 'survivalTime', 'driveDistance', 'marchDistance',
      'assists', 'outsideBlueCircleTime', 'knockouts', 'rescueTimes',
      'useSmokeGrenadeNum', 'useFragGrenadeNum', 'useBurnGrenadeNum', 'useFlashGrenadeNum',
      'PoisonTotalDamage', 'UseSelfRescueTime', 'UseEmergencyCallTime', 'teamIdfromApi',
      'contribution', 'location'
    ];

    // These should never legitimately go negative — an operator mistyping
    // a value (or a stray negative delta, see killNumChange below) must not
    // be able to write a negative stat straight into MongoDB with zero
    // validation (the schema itself has no `min` guard on these).
    const NONNEG_NUMERIC_FIELDS = new Set([
      'health', 'healthMax', 'liveState', 'killNumBeforeDie', 'gotAirDropNum',
      'maxKillDistance', 'damage', 'killNumInVehicle', 'killNumByGrenade',
      'AIKillNum', 'BossKillNum', 'rank', 'inDamage', 'headShotNum',
      'survivalTime', 'driveDistance', 'marchDistance', 'assists',
      'outsideBlueCircleTime', 'knockouts', 'rescueTimes', 'useSmokeGrenadeNum',
      'useFragGrenadeNum', 'useBurnGrenadeNum', 'useFlashGrenadeNum',
      'PoisonTotalDamage', 'UseSelfRescueTime', 'UseEmergencyCallTime',
      'contribution',
    ]);

    const setOps = {};
    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        let value = updateData[field];
        if (NONNEG_NUMERIC_FIELDS.has(field) && typeof value === 'number') {
          value = Math.max(0, value);
        }
        setOps[`teams.$[team].players.$[player].${field}`] = value;
      }
    });

    const arrayFilters = [
      { $or: [{ 'team._id': teamObjId }, { 'team.teamId': teamObjId }] },
      { 'player._id': playerObjId },
    ];

    let updated;
    if (updateData.killNumChange !== undefined) {
      const change = Number(updateData.killNumChange) || 0;
      if (change < 0) {
        // Don't trust the caller's delta to already be floor-safe — it was
        // computed client-side against a possibly-stale local killNum
        // (front/src/dashboard/matchDataController.tsx's updateKillCount),
        // and a blind $inc here could drive the real, current value
        // negative if a live PCOB tick moved it in between. Instead,
        // atomically apply the decrement ONLY if the CURRENT stored value
        // (checked by Mongo itself, at write time, via the arrayFilter
        // condition below — not a separate read-then-write race) can
        // absorb it without crossing zero; otherwise fall through and
        // clamp to exactly 0. Both branches remain single atomic
        // findOneAndUpdate calls, same pattern as the rest of this
        // endpoint.
        updated = await MatchData.findOneAndUpdate(
          { _id: matchDataId, matchId, userId },
          { $inc: { 'teams.$[team].players.$[player].killNum': change }, ...(Object.keys(setOps).length ? { $set: setOps } : {}) },
          {
            new: true,
            arrayFilters: [
              arrayFilters[0],
              { ...arrayFilters[1], 'player.killNum': { $gte: -change } },
            ],
          }
        ).lean();

        if (!updated) {
          updated = await MatchData.findOneAndUpdate(
            { _id: matchDataId, matchId, userId },
            { $set: { ...setOps, 'teams.$[team].players.$[player].killNum': 0 } },
            { new: true, arrayFilters }
          ).lean();
        }
      } else {
        updated = await MatchData.findOneAndUpdate(
          { _id: matchDataId, matchId, userId },
          { $inc: { 'teams.$[team].players.$[player].killNum': change }, ...(Object.keys(setOps).length ? { $set: setOps } : {}) },
          { new: true, arrayFilters }
        ).lean();
      }
    } else {
      if (updateData.killNum !== undefined) {
        setOps['teams.$[team].players.$[player].killNum'] = Math.max(0, Number(updateData.killNum) || 0);
      }
      if (!Object.keys(setOps).length) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      updated = await MatchData.findOneAndUpdate(
        { _id: matchDataId, matchId, userId },
        { $set: setOps },
        { new: true, arrayFilters }
      ).lean();
    }

    if (!updated) {
      return res.status(404).json({ error: 'MatchData not found or not yours' });
    }

    const team = updated.teams.find(t => matchesTeamId(t, teamId));
    const player = team?.players.find(p => String(p._id) === String(playerId));
    if (!team || !player) {
      return res.status(404).json({ error: 'Team or player not found' });
    }

    const updates = {};
    allowedFields.forEach(f => { if (updateData[f] !== undefined) updates[f] = updateData[f]; });
    if (updateData.killNumChange !== undefined || updateData.killNum !== undefined) {
      updates.killNum = player.killNum;
    }

    const io = getSocket();
    const room = `user:${userId}`;
    console.log(`[socket] playerStatsUpdated -> ${room} player=${playerId}`);
    io.to(room).emit('playerStatsUpdated', { matchDataId, teamId, playerId, updates });

    if (updates.killNum !== undefined) {
      const teamTotalKills = team.players.reduce((sum, p) => sum + (p.killNum || 0), 0);
      io.to(room).emit('teamStatsUpdated', {
        matchDataId,
        teamId,
        totalKills: teamTotalKills,
        players: team.players.map(p => ({ _id: p._id, killNum: p.killNum })),
      });
    }

    res.json({ message: 'Player stats updated', player });

    emitOverallUpdateAsync(io, matchId, userId, updated);
  } catch (error) {
    console.error('Error in updatePlayerStats:', error);
    res.status(500).json({ error: error.message });
  }
};

const deleteMatchDataById = async (req, res) => {
  try {
    const { tournamentId, roundId, id } = req.params;
    const match = await Match.findOneAndDelete({ _id: id, tournamentId, roundId, userId: req.session.userId });
    if (!match) return res.status(404).json({ error: 'Match not found in this round/tournament' });
    await MatchData.deleteMany({ matchId: match._id, userId: req.session.userId });
    return res.json({ message: 'Match and related MatchData deleted successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// Bulk update all players in a team (e.g., toggle bHasDied for entire team)
const updateTeamPlayersBulkStats = async (req, res) => {
  const { matchId, matchDataId, teamId } = req.params;
  const lockKey = `${matchDataId}-${teamId}-bulk`;

  if (!acquireLock(lockKey)) {
    console.log('Bulk team update already in progress for:', lockKey);
    return res.status(429).json({ error: 'Update already in progress, please wait' });
  }

  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const userId = req.session.userId;

    const { bHasDied } = req.body;
    if (typeof bHasDied !== 'boolean') {
      return res.status(400).json({ error: 'bHasDied must be a boolean' });
    }

    const teamObjId = toObjectIdOrNull(teamId);
    if (!teamObjId) return res.status(400).json({ error: 'Invalid teamId' });

    // `players.$[]` applies to every element of the nested players array in
    // one atomic write — no need to load the document, mutate every player
    // in JS, then save() the whole thing back.
    const result = await MatchData.findOneAndUpdate(
      { _id: matchDataId, matchId, userId },
      { $set: { 'teams.$[team].players.$[].bHasDied': bHasDied } },
      {
        new: true,
        arrayFilters: [{ $or: [{ 'team._id': teamObjId }, { 'team.teamId': teamObjId }] }],
      }
    ).lean();

    if (!result) return res.status(404).json({ error: 'MatchData or Team not found, or not yours' });

    const team = result.teams.find(t => matchesTeamId(t, teamId));

    const io = getSocket();
    console.log(`[socket] matchDataUpdated -> user:${userId} team=${teamId} bulkDied`);
    io.to(`user:${userId}`).emit('matchDataUpdated', {
      matchDataId,
      teamId,
      changes: { players: team.players.map(p => ({ _id: p._id, bHasDied: p.bHasDied })) },
    });

    res.json({ message: 'Team players updated', teamId, bHasDied });

    emitOverallUpdateAsync(io, matchId, userId, result);
  } catch (error) {
    console.error('Error in bulk team update:', error);
    res.status(500).json({ error: error.message });
  } finally {
    releaseLock(lockKey);
  }
};

const updatePlayerByIdInMatchData = async (req, res) => {
  try {
    const { matchDataId, teamId } = req.params;
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { replacements } = req.body;

    if (!Array.isArray(replacements) || replacements.length === 0) {
      return res.status(400).json({ error: 'No replacements provided' });
    }

    // Single ownership-scoped fetch — the previous version's real working
    // query (`MatchData.findById(matchDataId)`, further down) had NO
    // userId filter at all and relied entirely on a separate check-and-
    // discard query earlier in the function. This one query now both
    // proves ownership and is the doc we actually mutate.
    const matchData = await MatchData.findOne({ _id: matchDataId, userId: req.session.userId });
    if (!matchData) return res.status(404).json({ error: 'MatchData not found or not yours' });

    const team = matchData.teams.find(t => matchesTeamId(t, teamId));
    if (!team) return res.status(404).json({ error: 'Team not found in MatchData' });

    const match = await Match.findById(matchData.matchId).populate({
      path: 'groups',
      populate: { path: 'slots.team', model: 'Team' }
    }).lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const matchTeam = (match.groups || [])
      .flatMap(g => g.slots || [])
      .map(s => s.team)
      .find(t => t && String(t._id) === String(team.teamId));
    if (!matchTeam) return res.status(404).json({ error: 'Matching team not found in match groups' });

    replacements.forEach(({ oldPlayerId, newPlayerId }) => {
      const playerIndex = team.players.findIndex(p => p._id.toString() === oldPlayerId);
      if (playerIndex === -1) return;

      const newPlayer = matchTeam.players.find(p => p._id.toString() === newPlayerId);
      if (!newPlayer) return;

      team.players[playerIndex] = buildFreshPlayer(newPlayer, team.slot, team.teamName);
    });

    matchData.markModified('teams');
    await matchData.save();

    const io = getSocket();
    console.log(`[socket] matchDataUpdated -> user:${req.session.userId} team=${teamId} replaced`);
    io.to(`user:${req.session.userId}`).emit('matchDataUpdated', { matchDataId, teamId, changes: { players: team.players } });

    return res.json({ message: 'Players updated successfully', team });
  } catch (err) {
    console.error('Error updating players in MatchData:', err);
    return res.status(500).json({ error: err.message });
  }
};

const addPlayersToTeamInMatchData = async (req, res) => {
  try {
    const { matchDataId, teamId } = req.params;
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { newPlayerIds } = req.body;

    if (!Array.isArray(newPlayerIds) || newPlayerIds.length === 0) {
      return res.status(400).json({ error: 'newPlayerIds must be a non-empty array' });
    }
    if (
      !mongoose.Types.ObjectId.isValid(matchDataId) ||
      !mongoose.Types.ObjectId.isValid(teamId) ||
      !newPlayerIds.every(id => mongoose.Types.ObjectId.isValid(id))
    ) {
      return res.status(400).json({ error: 'Invalid ObjectId format for one or more IDs' });
    }

    const matchData = await MatchData.findOne({ _id: matchDataId, userId: req.session.userId });
    if (!matchData) return res.status(404).json({ error: 'MatchData not found or not yours' });

    const team = matchData.teams.find(t => matchesTeamId(t, teamId));
    if (!team) return res.status(404).json({ error: 'Team not found in this MatchData' });

    const match = await Match.findById(matchData.matchId).populate({
      path: 'groups',
      populate: { path: 'slots.team', model: 'Team' }
    }).lean();
    if (!match) return res.status(404).json({ error: 'Match not found' });

    let matchTeam = null;
    for (const group of match.groups || []) {
      for (const slot of group.slots || []) {
        if (slot.team && String(slot.team._id) === String(team.teamId)) {
          matchTeam = slot.team;
          break;
        }
      }
      if (matchTeam) break;
    }
    if (!matchTeam) return res.status(404).json({ error: 'Matching team not found in match groups' });

    const playersToAdd = newPlayerIds
      .filter(id => !team.players.some(p => p._id.toString() === id))
      .map(id => matchTeam.players.find(p => p._id.toString() === id))
      .filter(Boolean);

    if (playersToAdd.length === 0) {
      return res.status(400).json({ error: 'All players are already in the team or invalid' });
    }

    playersToAdd.forEach(newPlayer => {
      team.players.push(buildFreshPlayer(newPlayer, team.slot, team.teamName));
    });

    matchData.markModified('teams');
    await matchData.save();

    const io = getSocket();
    console.log(`[socket] matchDataUpdated -> user:${req.session.userId} team=${teamId} added`);
    io.to(`user:${req.session.userId}`).emit('matchDataUpdated', { matchDataId, teamId, changes: { players: team.players } });

    return res.json({ message: 'Players added successfully', team });
  } catch (error) {
    console.error('Error adding players to MatchData:', error);
    return res.status(500).json({ error: error.message });
  }
};

const removePlayersFromTeamInMatchData = async (req, res) => {
  try {
    const { matchDataId, teamId } = req.params;
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { playerIds } = req.body;

    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds must be a non-empty array' });
    }
    if (!mongoose.Types.ObjectId.isValid(matchDataId) || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ error: 'Invalid ObjectId format for matchDataId or teamId' });
    }
    const invalidPlayer = playerIds.find(id => !mongoose.Types.ObjectId.isValid(id));
    if (invalidPlayer) {
      return res.status(400).json({ error: `Invalid ObjectId format for playerId: ${invalidPlayer}` });
    }

    const matchData = await MatchData.findOne({ _id: matchDataId, userId: req.session.userId });
    if (!matchData) return res.status(404).json({ error: 'MatchData not found or not yours' });

    const team = matchData.teams.find(t => matchesTeamId(t, teamId));
    if (!team) return res.status(404).json({ error: 'Team not found in this MatchData' });

    team.players = team.players.filter(p => !playerIds.includes(p._id.toString()));

    matchData.markModified('teams');
    await matchData.save();

    const io = getSocket();
    console.log(`[socket] matchDataUpdated -> user:${req.session.userId} team=${teamId} removed`);
    io.to(`user:${req.session.userId}`).emit('matchDataUpdated', { matchDataId, teamId, changes: { players: team.players } });

    return res.json({ message: 'Players removed successfully', team });
  } catch (error) {
    console.error('Error removing players from MatchData:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createMatchDataForMatchDoc,
  syncMatchDataTeamsForGroup,
  getMatchDataByMatchId,
  updateTeamPoints,
  deleteMatchDataById,

  updatePlayerStats,
  updatePlayerByIdInMatchData,
  addPlayersToTeamInMatchData,
  removePlayersFromTeamInMatchData,
  updateTeamPlayersBulkStats
};