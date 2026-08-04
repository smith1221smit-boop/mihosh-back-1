const Team = require('../../models/teams.model');
const MatchData = require('../../models/matchData.model');
const mongoose = require('mongoose');

/**
 * Update Teams DB with API players from matchData
 * - Maps API teamId (slot) → matchData team slot → teams DB _id
 * - Only adds players with new UID
 * @param {Array} apiPlayers - API player list
 * @param {String} matchId - matchData ID to map slot → team DB
 */
async function updateTeamsWithApiPlayers(apiPlayers, matchId, userId) {
  try {
    let newPlayersAdded = 0;
    let skipCount = 0;

    // --- Fetch matchData for this match to map slot → DB teamId ---
    const matchData = await MatchData.findOne({ matchId, userId });
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
    for (const team of teams) {
      for (const p of team.players || []) {
        if (p.playerId) knownUidToTeamId.set(String(p.playerId), team._id.toString());
      }
    }

    const MAX_PLAYERS = 4;

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

      team.markModified('players');
      await team.save();
      knownUidToTeamId.set(String(uId), String(team._id));
      newPlayersAdded++;
    }

    // Finished - silent
    if (skipCount > 0) {
      console.log(`[EXISTS] ${skipCount} players`);
    }
  } catch (err) {
    console.error('Error updating teams:', err);
  }
}

module.exports = updateTeamsWithApiPlayers;

