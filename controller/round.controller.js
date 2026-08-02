const mongoose = require('mongoose');
const Round = require('../models/round.model');
const Group = require('../models/group.model');
const Match = require('../models/match.model');
const MatchSelection = require('../models/MatchSelection.model');
const Tournament = require('../models/tournament.model');
const { invalidateScope } = require('../middleware/cache.js');

const ALLOWED_UPDATE_FIELDS = ['roundName', 'torLogo', 'day', 'groups', 'apiEnable', 'selectedMatch'];

// Fire-and-forget — must not block the response. Only needs to finish
// before the *next* read of this tournament's public data.
const invalidatePublicScope = (tournamentId) => {
  invalidateScope(`public:tournament:${tournamentId}`).catch(err =>
    console.warn('Public scope invalidation failed:', err.message)
  );
};

// ---------------- CREATE ROUND ----------------
const createRoundInTournament = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tournamentId } = req.params;
    const { roundName, torLogo, day, groups, apiEnable } = req.body;
    const createdBy = req.session.userId;

    if (!createdBy) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Ensure the tournament this round is being attached to actually
    // belongs to the caller — without this, any authenticated user could
    // create a round (with linked groups/matches) under someone else's
    // tournament just by supplying their tournamentId.
    const tournament = await Tournament.findOne({ _id: tournamentId, userId: createdBy }).session(session);
    if (!tournament) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'Tournament not found' });
    }

    if (apiEnable === true) {
      // Filter includes apiEnable: true so this hits the partial index
      // and touches at most one document, instead of scanning every
      // round this user has ever created.
      await Round.updateMany({ createdBy, apiEnable: true }, { $set: { apiEnable: false } }, { session });
    }

    const newRound = await Round.create(
      [{ tournamentId, roundName, torLogo, day, groups, apiEnable: !!apiEnable, createdBy }],
      { session }
    );

    const savedRound = newRound[0];

    if (Array.isArray(groups) && groups.length > 0) {
      await Promise.all([
        Group.updateMany(
          { _id: { $in: groups } },
          { $set: { roundId: savedRound._id } },
          { session }
        ),
        Match.updateMany(
          { roundId: savedRound._id },
          { $addToSet: { groups: { $each: groups } } },
          { session }
        ),
      ]);
    }

    await session.commitTransaction();
    session.endSession();

    res.status(201).json(savedRound);

    // After responding: clear public cache. Doesn't block the client.
    invalidatePublicScope(tournamentId);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Another round is already API-enabled for your account. Please retry.' });
    }
    res.status(500).json({ message: 'Error creating round', error: err.message });
  }
};

// ---------------- GET ROUND BY ID ----------------
const getRoundById = async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const round = await Round.findOne({ _id: req.params.id, createdBy: userId })
      .populate({ path: 'groups', populate: { path: 'slots.team' } });

    if (!round) {
      return res.status(404).json({ error: 'Round not found' });
    }

    res.json(round);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------------- GET ROUNDS BY TOURNAMENT ----------------
const getRoundsByTournamentId = async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rounds = await Round.find({ tournamentId: req.params.tournamentId, createdBy: userId })
      .populate({ path: 'groups', populate: { path: 'slots.team' } })
      .sort({ createdAt: -1 });

    res.json(rounds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------------- GET ROUNDS BY USER ----------------
const getRoundsByUser = async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rounds = await Round.find({ createdBy: userId })
      .populate({ path: 'groups', populate: { path: 'slots.team' } })
      .sort({ createdAt: -1 });

    res.json(rounds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------------- UPDATE ROUND ----------------
const updateRound = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { tournamentId, id } = req.params;
    const updateData = req.body;
    const userId = req.session.userId;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const round = await Round.findOne({ _id: id, tournamentId, createdBy: userId }).session(session);
    if (!round) {
      await session.abortTransaction();
      session.endSession();
      return res.status(403).json({ error: 'You are not allowed to update this round' });
    }

    if (updateData.apiEnable === true) {
      // Same fix: filter on apiEnable: true to hit the partial index.
      await Round.updateMany(
        { createdBy: userId, apiEnable: true, _id: { $ne: id } },
        { $set: { apiEnable: false } },
        { session }
      );
    }

    const wasApiEnabled = round.apiEnable;

    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(updateData, field)) {
        round[field] = updateData[field];
      }
    }

    const updatedRound = await round.save({ session });

    if (wasApiEnabled && !updatedRound.apiEnable) {
      await MatchSelection.updateMany(
        { roundId: updatedRound._id },
        { $set: { isPollingActive: false } },
        { session }
      );
    }

    await session.commitTransaction();
    session.endSession();

    res.json(updatedRound);

    invalidatePublicScope(tournamentId);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Another round is already API-enabled for your account. Please retry.' });
    }
    res.status(400).json({ error: err.message });
  }
};

// ---------------- DELETE ROUND ----------------
const deleteRound = async (req, res) => {
  try {
    const { tournamentId, id } = req.params;
    const userId = req.session.userId;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const round = await Round.findOneAndDelete({ _id: id, tournamentId, createdBy: userId });
    if (!round) return res.status(403).json({ error: 'You are not allowed to delete this round' });

    await MatchSelection.deleteMany({ roundId: id });

    res.json({ message: 'Round deleted successfully' });

    invalidatePublicScope(tournamentId);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ---------------- GET ALL ROUNDS (USER-BASED) ----------------
const getAllRounds = async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const rounds = await Round.find({ createdBy: userId })
      .populate({ path: 'groups', populate: { path: 'slots.team' } })
      .sort({ createdAt: -1 });

    res.json(rounds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createRoundInTournament,
  getRoundById,
  getRoundsByTournamentId,
  getRoundsByUser,
  updateRound,
  deleteRound,
  getAllRounds,
};