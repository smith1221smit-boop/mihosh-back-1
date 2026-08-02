const MatchData = require('../../models/matchData.model');
const Match = require('../../models/match.model');
const mongoose = require('mongoose');

const createMatchDataForMatchDoc = async (matchOrId) => {
  try {
    if (!matchOrId) throw new Error('No matchId provided');
    const matchId = typeof matchOrId === 'object' && matchOrId._id ? matchOrId._id : matchOrId;

    // Fetch Match and populate nested groups -> slots -> team -> players
    const match = await Match.findById(matchId).populate({
      path: 'groups',
      populate: {
        path: 'slots.team',
        populate: {
          path: 'players', // ensure players are populated
        }
      }
    });

    if (!match) throw new Error('Match not found');

    // Flatten all teams from populated match.groups[].slots[].team
    let teams = (match.groups || []).flatMap(group =>
      (group.slots || [])
        .filter(slot => slot.team)
        .map(slot => ({
          slot: slot.slot, // ✅ add slot
          teamId: slot.team._id,
          teamLogo : slot.team.logo || '',
          teamName: slot.team.teamFullName || slot.team.teamName || '',
          teamTag: slot.team.teamTag || '',
          players: (slot.team.players || []).slice(0, 4).map(player => ({
            uId: player.playerId || '',
            _id: player._id,
            playerName: player.playerName,
            playerOpenId: player.playerOpenId || '',
            picUrl: player.photo || '',
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
            teamId: slot.slot,
            teamName: slot.team.teamFullName || '',
            contribution: 0,
          }))
        }))
    );

    // SORT teams by slot (lowest to highest)
    teams.sort((a, b) => a.slot - b.slot);

    // Create new MatchData document
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

module.exports = {
  createMatchDataForMatchDoc,
};

