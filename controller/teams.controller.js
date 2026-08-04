// controllers/teams.controller.js
const Team = require('../models/teams.model.js');
const User = require('../models/User.model.js');
const mongoose = require('mongoose');

// Default assets
const DEFAULT_TEAM_LOGO = '/def_logo.avif';
const DEFAULT_PLAYER_PHOTO = '/def_char.avif';
const DEFAULT_TEAM_FLAG = '/def_flag.avif';

const MAX_PLAYERS = 100; // sanity cap — adjust to your real roster limit

// ─── Shared helpers ──────────────────────────────────────────────────────
// Strips hiddenBy off the team and every player, and replaces it with a
// simple isHidden boolean scoped to the requesting user. Keeps every
// endpoint's response shape consistent instead of only getTeamById doing it.
function sanitizeTeam(team, userId) {
  if (!team) return team;
  const isHidden = !!(userId && team.hiddenBy?.some(id => String(id) === String(userId)));
  const { hiddenBy, players, ...rest } = team;
  return {
    ...rest,
    isHidden,
    players: (players || []).map(({ hiddenBy: playerHiddenBy, ...p }) => ({
      ...p,
      isHidden: !!(userId && playerHiddenBy?.some(id => String(id) === String(userId))),
    })),
  };
}

// A team is mutable by its creator, or by anyone if it's legacy/unclaimed
// (createdBy is null — predates per-user team ownership), or by an admin.
async function canMutateTeam(req, createdBy) {
  if (!createdBy || String(createdBy) === String(req.session.userId)) return true;
  const requester = await User.findById(req.session.userId).select('isAdmin').lean();
  return !!requester?.isAdmin;
}

async function isRequesterAdmin(req) {
  if (!req.session?.userId) return false;
  const requester = await User.findById(req.session.userId).select('isAdmin').lean();
  return !!requester?.isAdmin;
}

// Same rule as canMutateTeam, but for reads: a team is visible to its
// creator, to anyone if it's legacy/unclaimed (no createdBy), or to an admin.
// Teams used to be a fully shared catalog — every user could browse every
// other user's rosters — this locks reads down to match the write-side rule.
function canViewTeam(userId, isAdmin, createdBy) {
  return isAdmin || !createdBy || String(createdBy) === String(userId);
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) return [];
  return players
    .slice(0, MAX_PLAYERS)
    .filter(p => p && typeof p.playerName === 'string' && p.playerName.trim())
    .map(p => ({
      playerName: p.playerName,
      playerId: p.playerId,
      photo: (typeof p.photo === 'string' && p.photo.trim()) ? p.photo : DEFAULT_PLAYER_PHOTO,
    }));
}

// ─── Player-identity validation ─────────────────────────────────────────
// Every roster player needs a working PUBG playerId (uId) — the live-match
// rebuild (pubgApiMatchData.controller.js) matches live API players into a
// team's roster by playerId, so a missing one means that player can never
// be found (shows up "missing" in MatchData, no photo). A playerId CAN
// legitimately be registered on more than one team (a player rostered on
// multiple teams across different tournaments, etc.) — that's allowed;
// pubgApiMatchData.controller.js's uidToTeam matching resolves which team
// a live tick's stats belong to deterministically (first team wins, with a
// warning logged) rather than rejecting the data here.
function validatePlayerIds(players) {
  const list = Array.isArray(players) ? players : [];
  const seen = new Map(); // playerId -> first index seen, to catch dupes within this same request

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p.playerName !== 'string' || !p.playerName.trim()) continue; // normalizePlayers drops these anyway
    const playerId = typeof p.playerId === 'string' ? p.playerId.trim() : '';
    if (!playerId) {
      return { ok: false, error: `Player "${p.playerName}" is missing a playerId (PUBG ID) — every roster player needs one so live stats can be matched correctly.` };
    }
    if (seen.has(playerId)) {
      return { ok: false, error: `playerId "${playerId}" is used by more than one player in this request.` };
    }
    seen.set(playerId, i);
  }

  return { ok: true };
}

// ─── Create a new team ───────────────────────────────────────────────────
const createTeam = async (req, res) => {
  try {
    const { teamFullName, teamTag, logo, teamFlag, players } = req.body;
    if (!teamFullName || !teamTag) {
      return res.status(400).json({ error: 'Team full name and tag are required' });
    }
    if (players !== undefined && !Array.isArray(players)) {
      return res.status(400).json({ error: 'players must be an array' });
    }
    if (Array.isArray(players) && players.length > MAX_PLAYERS) {
      return res.status(400).json({ error: `players cannot exceed ${MAX_PLAYERS}` });
    }

    if (Array.isArray(players) && players.length) {
      const validation = validatePlayerIds(players);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
    }

    const finalLogo = (typeof logo === 'string' && logo.trim()) ? logo : DEFAULT_TEAM_LOGO;
    const finalFlag = (typeof teamFlag === 'string' && teamFlag.trim()) ? teamFlag : DEFAULT_TEAM_FLAG;
    const normalizedPlayers = normalizePlayers(players);

    const team = new Team({
      teamFullName,
      teamTag,
      logo: finalLogo,
      teamFlag: finalFlag,
      createdBy: req.session.userId,
      players: normalizedPlayers,
    });
    const savedTeam = await team.save();
    console.log(`[TEAMS] created name=${teamFullName} players=${normalizedPlayers.length}`);
    res.status(201).json(sanitizeTeam(savedTeam.toObject(), req.session?.userId));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A team with that tag already exists' });
    }
    console.error(`[ERROR] team=create-failed msg=${err.message}`);
    res.status(400).json({ error: err.message });
  }
};

// ─── Get team by ID ──────────────────────────────────────────────────────
const getTeamById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid team id' });
    }
    const userId = req.session?.userId;
    const team = await Team.findById(req.params.id).lean();
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const isAdmin = userId ? await isRequesterAdmin(req) : false;
    if (!canViewTeam(userId, isAdmin, team.createdBy)) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const sanitized = sanitizeTeam(team, userId);
    // detail view: only drop players the requesting user has hidden
    sanitized.players = sanitized.players.filter(p => !p.isHidden);

    res.json(sanitized);
  } catch (err) {
    console.error(`[ERROR] team=getById-failed msg=${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

// ─── Get all teams (paginated, filtered, list-projected) ───────────────
const getAllTeams = async (req, res) => {
  try {
    const userId = req.session?.userId;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const search = req.query.search?.trim();
    const isAdmin = userId ? await isRequesterAdmin(req) : false;

    const conditions = [];
    if (userId) conditions.push({ hiddenBy: { $ne: userId } });
    if (search) {
      conditions.push({
        $or: [
          { teamFullName: { $regex: search, $options: 'i' } },
          { teamTag: { $regex: search, $options: 'i' } },
        ],
      });
    }
    if (!isAdmin) {
      // Own teams + legacy/unclaimed ones only — never another user's
      // private roster.
      conditions.push({
        $or: [
          { createdBy: { $exists: false } },
          { createdBy: null },
          ...(userId ? [{ createdBy: new mongoose.Types.ObjectId(userId) }] : []),
        ],
      });
    }
    const filter = conditions.length ? { $and: conditions } : {};

    const [teams, total] = await Promise.all([
      Team.aggregate([
        { $match: filter },
        { $sort: { _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            teamFullName: 1,
            teamTag: 1,
            logo: 1,
            teamFlag: 1,
            playersCount: { $size: '$players' },
          },
        },
      ]),
      Team.countDocuments(filter),
    ]);

    console.log(`[TEAMS] fetched page=${page} limit=${limit} total=${total}`);
    res.json({ teams, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error(`[ERROR] team=getAll-failed msg=${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

// ─── Update team info (atomic — no full-doc load/save) ─────────────────
const updateTeam = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid team id' });
    }
    const { teamFullName, teamTag, logo, teamFlag, players } = req.body;

    if (players !== undefined && !Array.isArray(players)) {
      return res.status(400).json({ error: 'players must be an array' });
    }
    if (Array.isArray(players) && players.length > MAX_PLAYERS) {
      return res.status(400).json({ error: `players cannot exceed ${MAX_PLAYERS}` });
    }

    const setOps = {};
    if (teamFullName) setOps.teamFullName = teamFullName;
    if (teamTag) setOps.teamTag = teamTag;
    if (logo !== undefined) setOps.logo = logo;
    if (teamFlag !== undefined) setOps.teamFlag = teamFlag;
    if (players) setOps.players = normalizePlayers(players);

    if (Object.keys(setOps).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const existing = await Team.findById(req.params.id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Team not found' });
    if (!(await canMutateTeam(req, existing.createdBy))) {
      return res.status(403).json({ error: 'Not authorized to update this team' });
    }

    if (players) {
      const validation = validatePlayerIds(players);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
    }

    const updatedTeam = await Team.findByIdAndUpdate(
      req.params.id,
      { $set: setOps },
      { new: true, runValidators: true }
    ).lean();

    if (!updatedTeam) return res.status(404).json({ error: 'Team not found' });

    console.log(`[TEAMS] updated id=${req.params.id} players=${updatedTeam.players.length}`);
    res.json(sanitizeTeam(updatedTeam, req.session?.userId));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A team with that tag already exists' });
    }
    console.error(`[ERROR] team=update-failed msg=${err.message}`);
    res.status(400).json({ error: err.message });
  }
};

// ─── Delete team by ID ───────────────────────────────────────────────────
const deleteTeam = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid team id' });
    }
    const existing = await Team.findById(req.params.id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Team not found' });
    if (!(await canMutateTeam(req, existing.createdBy))) {
      return res.status(403).json({ error: 'Not authorized to delete this team' });
    }

    const deleted = await Team.findByIdAndDelete(req.params.id).lean();
    if (!deleted) return res.status(404).json({ error: 'Team not found' });
    console.log(`[TEAMS] deleted id=${req.params.id}`);
    res.json({ message: 'Team deleted successfully' });
  } catch (err) {
    console.error(`[ERROR] team=delete-failed msg=${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

// ─── Add a player to a team (atomic $push) ──────────────────────────────
const addPlayerToTeam = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid team id' });
    }
    const { playerName, playerId, photo } = req.body;
    if (!playerName) return res.status(400).json({ error: 'Player name is required' });
    if (typeof playerId !== 'string' || !playerId.trim()) {
      return res.status(400).json({ error: 'playerId (PUBG ID) is required' });
    }

    const finalPhoto = (typeof photo === 'string' && photo.trim()) ? photo : DEFAULT_PLAYER_PHOTO;

    const existing = await Team.findById(id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Team not found' });
    if (!(await canMutateTeam(req, existing.createdBy))) {
      return res.status(403).json({ error: 'Not authorized to modify this team' });
    }

    const validation = validatePlayerIds([{ playerName, playerId }]);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    // Guard the roster size cap atomically via a conditional filter —
    // avoids a separate read just to count players.
    const team = await Team.findOneAndUpdate(
      { _id: id, $expr: { $lt: [{ $size: '$players' }, MAX_PLAYERS] } },
      { $push: { players: { playerName, playerId, photo: finalPhoto } } },
      { new: true, runValidators: true }
    ).lean();

    if (!team) {
      const exists = await Team.exists({ _id: id });
      if (!exists) return res.status(404).json({ error: 'Team not found' });
      return res.status(400).json({ error: `Team already has the maximum of ${MAX_PLAYERS} players` });
    }

    console.log(`[TEAMS] player-added teamId=${id} playerName=${playerName}`);
    res.status(201).json(sanitizeTeam(team, req.session?.userId));
  } catch (err) {
    console.error(`[ERROR] team=add-player-failed msg=${err.message}`);
    res.status(400).json({ error: err.message });
  }
};

// ─── Remove a single player from a team (atomic $pull) ──────────────────
const removePlayerFromTeam = async (req, res) => {
  try {
    const { id, playerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ error: 'Invalid team id or player id' });
    }

    const existing = await Team.findById(id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Team not found' });
    if (!(await canMutateTeam(req, existing.createdBy))) {
      return res.status(403).json({ error: 'Not authorized to modify this team' });
    }

    const team = await Team.findByIdAndUpdate(
      id,
      { $pull: { players: { _id: playerId } } },
      { new: true }
    ).lean();

    if (!team) return res.status(404).json({ error: 'Team not found' });

    console.log(`[TEAMS] player-removed teamId=${id} playerId=${playerId}`);
    res.json({ message: 'Player removed successfully', team: sanitizeTeam(team, req.session?.userId) });
  } catch (err) {
    console.error(`[ERROR] team=remove-player-failed msg=${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

// ─── Remove multiple players from a team (atomic $pull with $in) ───────
const removeMultiplePlayersFromTeam = async (req, res) => {
  try {
    const { id } = req.params;
    const { playerIds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid team id' });
    }
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      return res.status(400).json({ error: 'playerIds array is required' });
    }
    const invalid = playerIds.find(pid => !mongoose.Types.ObjectId.isValid(pid));
    if (invalid) {
      return res.status(400).json({ error: `Invalid player id: ${invalid}` });
    }

    const existing = await Team.findById(id).select('createdBy').lean();
    if (!existing) return res.status(404).json({ error: 'Team not found' });
    if (!(await canMutateTeam(req, existing.createdBy))) {
      return res.status(403).json({ error: 'Not authorized to modify this team' });
    }

    const team = await Team.findByIdAndUpdate(
      id,
      { $pull: { players: { _id: { $in: playerIds } } } },
      { new: true }
    ).lean();

    if (!team) return res.status(404).json({ error: 'Team not found' });

    console.log(`[TEAMS] players-removed teamId=${id} count=${playerIds.length}`);
    res.json({ message: 'Players removed successfully', team: sanitizeTeam(team, req.session?.userId) });
  } catch (err) {
    console.error(`[ERROR] team=remove-multiple-failed msg=${err.message}`);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  createTeam,
  getAllTeams,
  getTeamById,
  updateTeam,
  deleteTeam,
  addPlayerToTeam,
  removePlayerFromTeam,
  removeMultiplePlayersFromTeam,
};