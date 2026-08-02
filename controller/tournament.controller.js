const Tournament = require('../models/tournament.model.js');
const Round = require('../models/round.model');
const Team = require('../models/teams.model');
const Match = require('../models/match.model');
const MatchData = require('../models/matchData.model');
const Group = require('../models/group.model');
const MatchSelection = require('../models/MatchSelection.model');

// --- CREATE TOURNAMENT ---
const createTournament = async (req, res) => {
  try {
    const tournament = new Tournament({
      ...req.body,
      userId: req.session.userId, // assign current user as owner
    });
    const savedTournament = await tournament.save();
    res.status(201).json(savedTournament);
  } catch (err) {
    console.error('createTournament error:', err);
    res.status(400).json({ error: err.message });
  }
};

// --- GET ALL TOURNAMENTS (current user only) ---
const getTournaments = async (req, res) => {
 console.log("Session in getTournaments:", req.session);
console.log("UserID in getTournaments:", req.session?.userId);
  try {
    const tournaments = await Tournament.find({ userId: req.session.userId }).lean();
    res.json(tournaments);
  } catch (err) {
    console.error('getTournaments error:', err);
    res.status(500).json({ error: err.message });
  }
};

// --- GET TOURNAMENT BY ID (owner check) ---
const getTournamentById = async (req, res) => {
  try {
    const tournament = await Tournament.findOne({ _id: req.params.id, userId: req.session.userId }).lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found or unauthorized' });

    const rounds = await Round.find({ tournamentId: tournament._id })
      .populate({
        path: 'groups',
        populate: { path: 'slots.team', model: 'Team' },
      })
      .lean();

    res.json({ ...tournament, rounds });
  } catch (err) {
    console.error('getTournamentById error:', err);
    res.status(500).json({ error: err.message });
  }
};

// --- GET TOURNAMENT BY NAME (owner check) ---
const getTournamentByName = async (req, res) => {
  try {
    const name = req.params.name.trim();
    const tournament = await Tournament.findOne({
      tournamentName: { $regex: `^${name}$`, $options: 'i' },
      userId: req.session.userId,
    });
    if (!tournament) return res.status(404).json({ error: 'Tournament not found or unauthorized' });
    res.json(tournament);
  } catch (err) {
    console.error('getTournamentByName error:', err);
    res.status(500).json({ error: err.message });
  }
};

// --- GET ROUNDS BY TOURNAMENT (owner check) ---
const getRoundsByTournamentId = async (req, res) => {
  try {
    const tournament = await Tournament.findOne({ _id: req.params.tournamentId, userId: req.session.userId });
    if (!tournament) return res.status(404).json({ error: 'Tournament not found or unauthorized' });

    const rounds = await Round.find({ tournamentId: tournament._id }).lean();
    res.json(rounds);
  } catch (err) {
    console.error('getRoundsByTournamentId error:', err);
    res.status(500).json({ error: err.message });
  }
};

// --- UPDATE TOURNAMENT (owner check) ---
const updateTournament = async (req, res) => {
  try {
    const updatedTournament = await Tournament.findOneAndUpdate(
      { _id: req.params.id, userId: req.session.userId },
      req.body,
      { new: true }
    );
    if (!updatedTournament) return res.status(404).json({ error: 'Tournament not found or unauthorized' });
    res.json(updatedTournament);
  } catch (err) {
    console.error('updateTournament error:', err);
    res.status(400).json({ error: err.message });
  }
};

// --- DELETE TOURNAMENT (owner check) ---
const deleteTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findOne({ _id: req.params.id, userId: req.session.userId });
    if (!tournament) return res.status(404).json({ error: 'Tournament not found or unauthorized' });

    const tournamentId = tournament._id;

    // Delete related data
    const rounds = await Round.find({ tournamentId }).select('_id');
    const roundIds = rounds.map(r => r._id);
    const matches = await Match.find({ roundId: { $in: roundIds } }).select('_id');
    const matchIds = matches.map(m => m._id);

    await Promise.all([
      Group.deleteMany({ tournamentId }),
      MatchData.deleteMany({ matchId: { $in: matchIds } }),
      Match.deleteMany({ _id: { $in: matchIds } }),
      Round.deleteMany({ _id: { $in: roundIds } }),
      MatchSelection.deleteMany({ tournamentId }),
      Tournament.findByIdAndDelete(tournamentId)
    ]);

    res.json({ message: 'Tournament and all related data deleted successfully' });
  } catch (err) {
    console.error('deleteTournament error:', err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createTournament,
  getTournaments,
  getTournamentById,
  getTournamentByName,
  updateTournament,
  deleteTournament,
  getRoundsByTournamentId
};
