const Match = require('../models/match.model');
const Round = require('../models/round.model');
const Tournament = require('../models/tournament.model');
const MatchData = require('../models/matchData.model');
const MatchSelection = require('../models/MatchSelection.model.js');

const { createMatchDataForMatchDoc } = require('./matchData.controller.js');
const { getSocket } = require('../socket.js');

// Convert time to 12-hour
function convertTo12Hour(time24) {
  if (!time24) return time24;
  const [hourStr, minute] = time24.split(':');
  let hour = parseInt(hourStr, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${hour.toString().padStart(2, '0')}:${minute} ${ampm}`;
}

// Fetch match with groups & matchData
async function fetchMatchWithData(match) {
  const populatedMatch = await match.populate({
    path: 'groups',
    populate: { path: 'slots.team', model: 'Team' },
  });
  const matchData = await MatchData.findOne({ matchId: match._id });
  return { ...populatedMatch.toObject(), matchData };
}

// ✅ Create match (user-based)
const createMatchInRoundInTournament = async (req, res) => {
  try {
    const { tournamentId, roundId } = req.params;
    const round = await Round.findOne({ _id: roundId, createdBy: req.session.userId });
    if (!round) return res.status(404).json({ message: 'Round not found or not yours' });

    let time = req.body.time ? convertTo12Hour(req.body.time) : undefined;

    const groupIds = req.body.groupIds?.length > 0
      ? req.body.groupIds
      : round.groups.map(g => g._id);

    const match = new Match({
      ...req.body,
      time,
      tournamentId,
      roundId,
      groups: groupIds,
      userId: req.session.userId, // ✅ assign owner
    });

    const savedMatch = await match.save();
    const createdMatchData = await createMatchDataForMatchDoc(savedMatch);

    const payload = { match: savedMatch, matchData: createdMatchData };
    getSocket().to(`user:${req.session.userId}`).emit('matchCreated', payload);

    res.status(201).json(payload);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ✅ Get match by ID
const getMatchById = async (req, res) => {
  try {
    const match = await Match.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!match) return res.status(404).json({ error: 'Match not found or not yours' });

    const matchWithData = await fetchMatchWithData(match);
    res.json(matchWithData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Get matches by round ID
const getMatchesByRoundId = async (req, res) => {
  try {
    const matches = await Match.find({ roundId: req.params.roundId, userId: req.session.userId });
    const matchesWithData = await Promise.all(matches.map(fetchMatchWithData));
    res.json(matchesWithData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Get matches by tournament ID
const getMatchesByTournamentId = async (req, res) => {
  try {
    const matches = await Match.find({ tournamentId: req.params.tournamentId, userId: req.session.userId });
    const matchesWithData = await Promise.all(matches.map(fetchMatchWithData));
    res.json(matchesWithData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Get matches by tournament & round
const getMatchesByTournamentAndRound = async (req, res) => {
  try {
    const matches = await Match.find({
      tournamentId: req.params.tournamentId,
      roundId: req.params.roundId,
      userId: req.session.userId,
    });
    const matchesWithData = await Promise.all(matches.map(fetchMatchWithData));
    res.json(matchesWithData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Update match
const updateMatch = async (req, res) => {
  try {
    const { tournamentId, roundId, id } = req.params;
    const match = await Match.findOne({ _id: id, tournamentId, roundId, userId: req.session.userId });
    if (!match) return res.status(404).json({ error: 'Match not found or not yours' });

    if (req.body.time !== undefined) {
      match.time = convertTo12Hour(req.body.time);
      delete req.body.time;
    }

    Object.assign(match, req.body);
    const updatedMatch = await match.save();
    const updatedMatchWithData = await fetchMatchWithData(updatedMatch);

    getSocket().to(`user:${req.session.userId}`).emit('matchUpdated', updatedMatchWithData);
    res.json(updatedMatchWithData);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// ✅ Delete match
const deleteMatch = async (req, res) => {
  try {
    const { roundId, tournamentId, id } = req.params;
    const match = await Match.findOneAndDelete({ _id: id, tournamentId, roundId, userId: req.session.userId });
    if (!match) return res.status(404).json({ error: 'Match not found or not yours' });

    await MatchData.deleteMany({ matchId: match._id });
    const deletedSelections = await MatchSelection.deleteMany({ matchId: match._id });

    getSocket().to(`user:${req.session.userId}`).emit('matchDeleted', { matchId: match._id });

    res.json({
      message: 'Match, related MatchData, and MatchSelections deleted successfully',
      deletedSelectionsCount: deletedSelections.deletedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Update all matches in a round (user-based)
const updateAllMatchesWithRoundGroups = async (req, res) => {
  try {
    const { roundId } = req.params;
    const round = await Round.findOne({ _id: roundId, createdBy: req.session.userId }).populate('groups');
    if (!round) return res.status(404).json({ message: 'Round not found or not yours' });

    const result = await Match.updateMany(
      { roundId: round._id, userId: req.session.userId },
      { $set: { groups: round.groups.map(g => g._id) } }
    );

    getSocket().to(`user:${req.session.userId}`).emit('roundGroupsUpdated', {
      roundId: round._id,
      modifiedCount: result.modifiedCount,
    });

    res.status(200).json({
      message: 'All matches updated with round groups',
      modifiedCount: result.modifiedCount,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error updating matches', error: err.message });
  }
};

module.exports = {
  createMatchInRoundInTournament,
  getMatchById,
  getMatchesByRoundId,
  getMatchesByTournamentId,
  getMatchesByTournamentAndRound,
  updateMatch,
  deleteMatch,
  updateAllMatchesWithRoundGroups,
};
