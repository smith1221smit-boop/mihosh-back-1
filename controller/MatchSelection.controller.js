const MatchSelection = require('../models/MatchSelection.model.js');
const Round = require('../models/round.model.js');
const { getSocket } = require('../socket'); // Socket.IO singleton

// Get all matches where isSelected = true for this user
const getAllSelectedMatches = async (req, res) => {
  try {
    const userId = req.session.userId;
    const selectedMatches = await MatchSelection.find({ isSelected: true, userId })
      .populate({
        path: 'roundId',
        select: 'apiEnable roundName'
      });

    if (selectedMatches.length === 0) {
      return res.status(404).json({ message: 'No selected matches found for this user' });
    }

    res.status(200).json(selectedMatches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Select / Deselect a match (user-based)
const selectMatch = async (req, res) => {
  try {
    const userId = req.session.userId;
    const { tournamentId, roundId, matchId } = req.body;

    if (!tournamentId || !roundId || !matchId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const io = getSocket();

    // Check if this match is already selected by this user
    const alreadySelected = await MatchSelection.findOne({
      tournamentId,
      roundId,
      matchId,
      userId,
      isSelected: true,
    });

    if (alreadySelected) {
      // Deselect it by deleting the selection
      await MatchSelection.deleteOne({ tournamentId, roundId, matchId, userId });

      const room = `user:${userId}`;
      console.log(`[socket] matchDeselected -> ${room} match=${matchId}`);
      io.to(room).emit('matchDeselected', { matchId, tournamentId, roundId, userId });

      return res.status(200).json({ message: 'Match deselected', deselected: matchId });
    }

    // Clear previous selection for this tournament & round for this user and disable polling
    const previousSelections = await MatchSelection.find({ tournamentId, roundId, userId, isSelected: true });
    const wasPollingActive = previousSelections.some(s => s.isPollingActive);

    await MatchSelection.updateMany(
      { tournamentId, roundId, userId },
      { $set: { isSelected: false, isPollingActive: false } }
    );

    const room = `user:${userId}`;

    // Emit polling status update for deselected matches
    const deselectedMatches = await MatchSelection.find({ tournamentId, roundId, userId, isSelected: false });
    console.log(`[socket] pollingStatusUpdated x${deselectedMatches.length} -> ${room}`);
    deselectedMatches.forEach(match => {
      io.to(room).emit('pollingStatusUpdated', {
        _id: match._id,
        matchId: match.matchId,
        roundId: match.roundId,
        tournamentId: match.tournamentId,
        isPollingActive: false
      });
    });

    // Emit matchDeselected for previously selected matches
    console.log(`[socket] matchDeselected x${previousSelections.length} -> ${room}`);
    previousSelections.forEach(prevMatch => {
      io.to(room).emit('matchDeselected', {
        matchId: prevMatch._id,
        tournamentId: prevMatch.tournamentId,
        roundId: prevMatch.roundId,
        userId: prevMatch.userId
      });
    });

    // Check if the round has API enabled, if not, also disable polling for the new selection
    const round = await Round.findById(roundId);
    const shouldDisablePolling = round && !round.apiEnable;

    if (shouldDisablePolling) {
      await MatchSelection.updateOne(
        { tournamentId, roundId, matchId, userId },
        { $set: { isPollingActive: false } }
      );
    }

    // Set the new selection
    const selectedMatch = await MatchSelection.findOneAndUpdate(
      { tournamentId, roundId, matchId, userId },
      { $set: { isSelected: true, isPollingActive: shouldDisablePolling ? false : undefined } },
      { upsert: true, new: true }
    );

    console.log(`[socket] matchSelected -> ${room} match=${matchId}`);
    io.to(room).emit('matchSelected', { selected: selectedMatch });

    res.status(200).json({ message: 'Match selected', selected: selectedMatch });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get currently selected match for a tournament & round (user-based)
const getSelectedMatch = async (req, res) => {
  try {
    const userId = req.session.userId;
    const { tournamentId, roundId } = req.params;

    if (!tournamentId || !roundId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const selected = await MatchSelection.findOne({
      tournamentId,
      roundId,
      userId,
      isSelected: true
    });

    if (!selected) {
      return res.status(404).json({ message: 'No match selected for this user' });
    }

    res.status(200).json(selected);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get all selections for a tournament & round (user-based)
const getAllSelections = async (req, res) => {
  try {
    const userId = req.session.userId;
    const { tournamentId, roundId } = req.params;

    if (!tournamentId || !roundId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const selections = await MatchSelection.find({ tournamentId, roundId, userId });
    res.status(200).json(selections);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Delete a match selection by matchId (user-based)
const deleteMatchSelection = async (req, res) => {
  try {
    const userId = req.session.userId;
    const { matchId } = req.params;

    if (!matchId) {
      return res.status(400).json({ message: 'Missing required matchId' });
    }

    const result = await MatchSelection.findOneAndDelete({ matchId, userId });

    if (!result) {
      return res.status(404).json({ message: 'Match selection not found for this user' });
    }

    const io = getSocket();
    const room = `user:${userId}`;
    console.log(`[socket] matchDeleted -> ${room} match=${matchId}`);
    io.to(room).emit('matchDeleted', { matchId, userId });

    res.status(200).json({ message: 'Match selection deleted successfully', result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  selectMatch,
  getSelectedMatch,
  getAllSelections,
  getAllSelectedMatches,
  deleteMatchSelection
};

