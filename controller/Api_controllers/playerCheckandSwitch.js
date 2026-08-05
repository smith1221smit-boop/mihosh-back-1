const Team = require('../../models/teams.model');
const MatchData = require('../../models/matchData.model');
const mongoose = require('mongoose');

// Per-match cache of every uId already registered to some team, as of the
// last full DB read. When this tick's apiPlayers contain no uId outside
// that set, the loop below is guaranteed to be a no-op (every player either
// already exists on their team, or is a known member of a different team
// and gets skipped) — so we can skip both DB reads entirely instead of
// re-fetching MatchData/Team every ~2s tick for a roster that isn't
// actually changing. Short TTL so any out-of-band roster edit still gets
// picked up quickly.
const knownPlayersCache = new Map(); // matchId -> { uids: Set<string>, expiresAt }
const KNOWN_PLAYERS_CACHE_TTL_MS = 10000;

/**
 * Update Teams DB with API players from matchData
 * - Maps API teamId (slot) → matchData team slot → teams DB _id
 * - Only adds players with new UID
 * @param {Array} apiPlayers - API player list
 * @param {String} matchId - matchData ID to map slot → team DB
 */
async function updateTeamsWithApiPlayers(apiPlayers, matchId, userId) {
  try {
    const matchKey = String(matchId);
    const cached = knownPlayersCache.get(matchKey);
    if (cached && cached.expiresAt > Date.now()) {
      const hasNewUid = apiPlayers.some(p => {
        const uId = p.uId;
        return uId && uId !== 'undefined' && uId !== '' && !cached.uids.has(String(uId));
      });
      if (!hasNewUid) return;
    }

    let newPlayersAdded = 0;
    let skipCount = 0;

    // --- Fetch matchData for this match to map slot → DB teamId ---
    // .lean(): only read here (slotToTeamId), never written back.
    const matchData = await MatchData.findOne({ matchId, userId }).lean();
    if (!matchData) return;

    const slotToTeamId = {};
    matchData.teams.forEach(team => {
      slotToTeamId[team.slot] = team.teamId; // teamId = ObjectId in teams DB
    });

    // --- Collect all relevant teams from DB ---
    const teamIds = Object.values(slotToTeamId);
    const teams = await Team.find({ _id: { $in: teamIds } });
    const teamMap = Object.fromEntries(teams.map(t => [t._id.toString(), t]));

    // Every uId already known to ANY team in this match, so a slot-based
    // guess (apiPlayer.teamId is PUBG's ephemeral in-match id, not
    // guaranteed to match our tournament slot numbering) that happens to
    // land on a uId already registered to a DIFFERENT team is treated as a
    // wrong guess rather than blindly re-adding it — this roster is shared
    // across tournaments, so a bad guess here corrupts it permanently, not
    // just this one match.
    const knownUidToTeamId = new Map();
    const allKnownUids = new Set();
    for (const team of teams) {
      for (const p of team.players || []) {
        if (p.playerId) {
          knownUidToTeamId.set(String(p.playerId), team._id.toString());
          allKnownUids.add(String(p.playerId));
        }
      }
    }

    const MAX_PLAYERS = 4;
    const modifiedTeams = new Set();

    for (const apiPlayer of apiPlayers) {
      const teamDbId = slotToTeamId[apiPlayer.teamId]; // map API slot → DB _id
      if (!teamDbId) continue;

      const team = teamMap[teamDbId];
      if (!team) continue;

      const uId = apiPlayer.uId;
      if (!uId || uId === 'undefined' || uId === '') continue;

      const exists = team.players.some(p => String(p.playerId) === String(uId));
      if (exists) {
        skipCount++;
        continue;
      }

      const owningTeamId = knownUidToTeamId.get(String(uId));
      if (owningTeamId && owningTeamId !== String(team._id)) {
        // Already a known member of a different team — the slot guess is
        // almost certainly wrong for this player this match, don't
        // misattribute them.
        continue;
      }

      if (team.players.length >= MAX_PLAYERS) continue;

      // Add new player
      team.players.push({
        _id: new mongoose.Types.ObjectId(),
        playerName: apiPlayer.playerName || '',
        playerId: String(uId),
        photo: apiPlayer.picUrl || ''
      });

      modifiedTeams.add(team);
      knownUidToTeamId.set(String(uId), String(team._id));
      allKnownUids.add(String(uId));
      newPlayersAdded++;
    }

    // Save every modified team in parallel instead of one sequential
    // `await team.save()` per new player — a burst of several new players
    // in one tick no longer serializes N round trips into a single tick's
    // latency budget.
    if (modifiedTeams.size > 0) {
      await Promise.all(
        Array.from(modifiedTeams).map(team => {
          team.markModified('players');
          return team.save();
        })
      );
    }

    knownPlayersCache.set(matchKey, {
      uids: allKnownUids,
      expiresAt: Date.now() + KNOWN_PLAYERS_CACHE_TTL_MS,
    });

    // Finished - silent
    if (skipCount > 0) {
      console.log(`[EXISTS] ${skipCount} players`);
    }
  } catch (err) {
    console.error('Error updating teams:', err);
  }
}

module.exports = updateTeamsWithApiPlayers;

