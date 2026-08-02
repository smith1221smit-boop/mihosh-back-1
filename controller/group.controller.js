const Group = require('../models/group.model.js');
const Team = require('../models/teams.model.js');
const Tournament = require('../models/tournament.model.js');

// CREATE Group (user-scoped)
const createGroup = async (req, res) => {
  try {
    const { groupName, slots, teams } = req.body;
    const { tournamentId } = req.params;

    let normalizedSlots = Array.isArray(slots) ? slots : [];
    if (!Array.isArray(normalizedSlots) && Array.isArray(teams)) {
      normalizedSlots = teams.map(t => ({
        team: t.teamId || t.team,
        slot: t.slot,
      }));
    }

    if (!groupName) return res.status(400).json({ message: 'groupName is required' });
    if (!tournamentId) return res.status(400).json({ message: 'tournamentId is required in params' });

    // Validate tournament and enforce ownership
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });
    if (!req.session || !req.session.userId || tournament.userId.toString() !== req.session.userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!Array.isArray(normalizedSlots) || normalizedSlots.length === 0) {
      return res.status(400).json({ message: 'Slots array is required and cannot be empty' });
    }

    // Validate teams
    const teamIds = normalizedSlots.map(s => s.team);
    const teamsExist = await Team.find({ _id: { $in: teamIds } });
    if (teamsExist.length !== teamIds.length) {
      const foundIds = teamsExist.map(t => t._id.toString());
      const missingIds = teamIds.filter(id => !foundIds.includes(id.toString()));
      console.error('❌ Missing team IDs:', missingIds);
      return res.status(400).json({ 
        message: 'Some teams in slots not found',
        missingTeamIds: missingIds 
      });
    }

    // Validate slot numbers
    for (const slot of normalizedSlots) {
      if (typeof slot.slot !== 'number' || slot.slot < 1) {
        return res.status(400).json({ message: 'Each slot must have a valid positive slot number' });
      }
    }

    const newGroup = new Group({
      groupName,
      tournamentId,
      userId: req.session.userId,
      slots: normalizedSlots,
    });

    const savedGroup = await newGroup.save();

    res.status(201).json(savedGroup);
  } catch (err) {
    console.error('createGroup error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET All Groups in Tournament (user-scoped)
const getAllGroups = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    // Ensure the tournament belongs to the current user
    const tournament = await Tournament.findOne({ _id: tournamentId, userId: req.session.userId });
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    const groups = await Group.find({ tournamentId, userId: req.session.userId })
      .populate('slots.team');
    res.json(groups);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET Group by ID in Tournament (user-scoped)
const getGroupById = async (req, res) => {
  try {
    const { tournamentId, id } = req.params;
    const group = await Group.findOne({ _id: id, tournamentId, userId: req.session.userId })
      .populate('slots.team');
    if (!group) {
      return res.status(404).json({ message: 'Group not found in this tournament' });
    }
    res.json(group);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// UPDATE Group in Tournament (user-scoped)
const updateGroup = async (req, res) => {
  try {
    const { tournamentId, id } = req.params;
    const { groupName, slots } = req.body;

    const group = await Group.findOne({ _id: id, tournamentId, userId: req.session.userId });
    if (!group) {
      return res.status(404).json({ message: 'Group not found in this tournament' });
    }

    if (groupName) group.groupName = groupName;

    if (Array.isArray(slots)) {
      const teamIds = slots.map(slot => slot.team);
      const teamsExist = await Team.find({ _id: { $in: teamIds } });
      if (teamsExist.length !== teamIds.length) {
        const foundIds = teamsExist.map(t => t._id.toString());
        const missingIds = teamIds.filter(id => !foundIds.includes(id.toString()));
        console.error('❌ Missing team IDs during update:', missingIds);
        return res.status(400).json({ 
          message: 'Some teams in slots not found',
          missingTeamIds: missingIds 
        });
      }
      for (const slot of slots) {
        if (typeof slot.slot !== 'number' || slot.slot < 1) {
          return res.status(400).json({ message: 'Each slot must have a valid positive slot number' });
        }
      }
      group.slots = slots;
    }

    const updatedGroup = await group.save();
    res.json(updatedGroup);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// DELETE Group in Tournament (user-scoped)
const deleteGroup = async (req, res) => {
  try {
    const { tournamentId, id } = req.params;
    const group = await Group.findOneAndDelete({ _id: id, tournamentId, userId: req.session.userId });
    if (!group) {
      return res.status(404).json({ message: 'Group not found in this tournament' });
    }
    res.json({ message: 'Group deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  createGroup,
  getAllGroups,
  getGroupById,
  updateGroup,
  deleteGroup,
};
