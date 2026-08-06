const Team = require('../../models/teams.model');
const mongoose = require('mongoose');

// Per-match cache of every uId already registered to some team, as of the
// last full DB read. When this tick's resolved players contain no uId
// outside that set, the loop below is guaranteed to be a no-op (every
// player either already exists on their team, or is a known member of a
// different team and gets skipped) — so we can skip the Team DB read
// entirely instead of re-fetching every ~2s tick for a roster that isn't
// actually changing. Short TTL so any out-of-band roster edit still gets
// picked up quickly.
const knownPlayersCache = new Map(); // matchId -> { uids: Set<string>, expiresAt }
const KNOWN_PLAYERS_CACHE_TTL_MS = 10000;

/**
 * Update Teams DB with API players already resolved to a team.
 *
 * Team assignment is NOT re-derived here — it's computed once, per tick, in
 * pubgApiMatchData.controller.js's updateMatchDataWithLiveStats (continuity
 * across ticks + an empirical apiTeamId<->team mapping built from
 * unambiguous players that tick), and handed to this function pre-resolved.
 * This function used to independently map `apiPlayer.teamId` (PUBG's
 * ephemeral in-match team id) straight onto a tournament `slot` number —
 * those two numbers are NOT guaranteed to be the same, and when an unrelated
 * squad in the match happened to get an in-game teamId that collided with a
 * team's slot number, their players got PERMANENTLY added to that team's
 * roster in the DB. Only ever adding players via the already-resolved
 * mapping removes that coincidental-collision path entirely, since a player
 * only reaches here once the caller's continuity/empirical-mapping logic has
 * actually placed them on this team.
 *
 * @param {Map<string, Array>} resolvedPlayersByTeamId - team DB _id (string) -> apiPlayer[]
 * @param {String} matchId - only used for the knownPlayersCache key/logging
 */
async function updateTeamsWithApiPlayers(resolvedPlayersByTeamId, matchId) {
  try {
    const matchKey = String(matchId);
    if (!resolvedPlayersByTeamId || resolvedPlayersByTeamId.size === 0) return;

    const allApiPlayers = [];
    for (const players of resolvedPlayersByTeamId.values()) allApiPlayers.push(...players);

    const cached = knownPlayersCache.get(matchKey);
    if (cached && cached.expiresAt > Date.now()) {
      const hasNewUid = allApiPlayers.some(p => {
        const uId = p.uId;
        return uId && uId !== 'undefined' && uId !== '' && !cached.uids.has(String(uId));
      });
      if (!hasNewUid) return;
    }

    let newPlayersAdded = 0;
    let skipCount = 0;

    // --- Collect all relevant teams from DB ---
    const teamIds = [...resolvedPlayersByTeamId.keys()];
    const teams = await Team.find({ _id: { $in: teamIds } });
    const teamMap = Object.fromEntries(teams.map(t => [t._id.toString(), t]));

    // Every uId already known to ANY team in this match — a resolved
    // assignment that happens to land on a uId already registered to a
    // DIFFERENT team is treated as a wrong guess rather than blindly
    // re-adding it — this roster is shared across tournaments, so a bad
    // guess here corrupts it permanently, not just this one match.
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

    for (const [teamDbId, apiPlayersForTeam] of resolvedPlayersByTeamId) {
      const team = teamMap[teamDbId];
      if (!team) continue;

      for (const apiPlayer of apiPlayersForTeam) {
        const uId = apiPlayer.uId;
        if (!uId || uId === 'undefined' || uId === '') continue;

        const exists = team.players.some(p => String(p.playerId) === String(uId));
        if (exists) {
          skipCount++;
          continue;
        }

        const owningTeamId = knownUidToTeamId.get(String(uId));
        if (owningTeamId && owningTeamId !== String(team._id)) {
          // Already a known member of a different team — don't misattribute.
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
