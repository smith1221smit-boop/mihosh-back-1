const Tournament = require('../models/tournament.model.js');
const Round = require('../models/round.model.js');
const Match = require('../models/match.model.js');
const msgpack = require('@msgpack/msgpack'); // npm install @msgpack/msgpack

const getSpecificData = async (req, res) => {
  try {
    const { tournamentId, roundId, matchId } = req.params;

    // Fetch tournament
    const tournament = await Tournament.findOne({ _id: tournamentId }).lean();
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

    // Fetch round
    const round = await Round.findOne({ _id: roundId, tournamentId }).populate('groups').lean();
    if (!round) return res.status(404).json({ error: 'Round not found' });

    // Fetch match
    let match = await Match.findOne({ _id: matchId, roundId }).populate('groups').lean();
    if (!match) {
      match = await Match.findOne({ _id: matchId }).populate('groups').lean();
    }
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const payload = { tournament, round, match };

    // Encode as MessagePack binary
    const binary = msgpack.encode(payload);

    // Set content type for binary
    res.setHeader('Content-Type', 'application/msgpack');
    res.send(Buffer.from(binary));
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
};

module.exports = { getSpecificData };