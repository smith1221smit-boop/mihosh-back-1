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

      // Add new player
      team.players.push({
        _id: new mongoose.Types.ObjectId(),
        playerName: apiPlayer.playerName || '',
        playerId: String(uId),
        photo: apiPlayer.picUrl || ''
      });

      team.markModified('players');
      await team.save();
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

