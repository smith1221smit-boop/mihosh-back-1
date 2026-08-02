const mongoose = require('mongoose');

const Tournament = require('../models/tournament.model');
const Round = require('../models/round.model');
const Match = require('../models/match.model');
const MatchData = require('../models/matchData.model');
const MatchSelection = require('../models/MatchSelection.model');
const Group = require('../models/group.model.js');
const { createMatchDataForMatchDoc } = require('./matchData.controller');

/* --------------------------------------------------------------------
   Same view -> data-requirement tables as the frontend
   (PublicThemeRenderer.tsx), kept in sync manually. If you add a view
   there that needs a new data source, mirror it here too.
-------------------------------------------------------------------- */
const VIEWS_NEEDING_OVERALL = new Set([
  'OverAllData', 'OverallFrags', 'LiveStats', '1stRunnerUp', '2ndRunnerUp', 'EventMvp', 'highlightPoints',
]);
const VIEWS_NEEDING_MATCH_DATA = new Set([
  'Upper', 'Dom', 'Alerts', 'LiveStats', 'LiveFrags', 'MatchData', 'Achive', 'MatchFragrs',
  'WwcdSummary', 'WwcdStats', 'playerH2H', 'mapPreview', 'slots', 'TeamH2H', 'mvp',
  'RosterShowCase', 'MatchSummary', 'Champions', '1stRunnerUp', '2ndRunnerUp', 'EventMvp',
  'PlayerSwitch', 'LiveData',
]);
const VIEWS_NEEDING_BACKPACK = new Set(['Upper']);
const VIEWS_NEEDING_MATCHES_LIST = new Set([
  'Lower', 'Schedule', 'HighlightSchedule', 'OverAllData', 'OverallFrags', 'highlightPoints',
]);
const VIEWS_NEEDING_ALL_MATCH_DATAS = new Set([
  'Schedule', 'highlightPoints', 'HighlightSchedule', 'OverAllData', 'OverallFrags',
]);

const NUMERIC_PLAYER_FIELDS = [
  'health', 'healthMax', 'liveState', 'killNum', 'killNumBeforeDie', 'gotAirDropNum', 'maxKillDistance', 'damage',
  'killNumInVehicle', 'killNumByGrenade', 'AIKillNum', 'BossKillNum', 'rank', 'inDamage', 'headShotNum', 'survivalTime',
  'driveDistance', 'marchDistance', 'assists', 'outsideBlueCircleTime', 'knockouts', 'rescueTimes', 'useSmokeGrenadeNum',
  'useFragGrenadeNum', 'useBurnGrenadeNum', 'useFlashGrenadeNum', 'PoisonTotalDamage', 'UseSelfRescueTime',
  'UseEmergencyCallTime', 'contribution',
];

// Field set actually read by the round-summary views (Schedule,
// HighlightSchedule, OverAllData, OverallFrags, highlightPoints) —
// confirmed against every theme's component. These are NOT live/real-time
// views (those use currentMatchData/overallData, untouched by this), so
// matchDatasData can drop every live-tick-only field (location, health,
// driveDistance, grenade counters, deadTeamList, ...) that these views
// never read. Keep in sync with VIEWS_NEEDING_ALL_MATCH_DATAS above if a
// future view added to that set needs more fields.
const SUMMARY_PLAYER_FIELDS = ['killNum', 'damage', 'assists', 'survivalTime', 'knockouts'];

// Builds a fresh, independent object rather than mutating matchData in
// place — matchDataMap's entries are shared/aliased with
// currentMatchData.matchData (the live match), so mutating here would risk
// stripping fields off the real-time payload too.
function slimMatchDataForList(matchData) {
  if (!matchData) return matchData;
  return {
    _id: matchData._id,
    matchId: matchData.matchId,
    teams: (matchData.teams || []).map(team => ({
      teamId: team.teamId ?? team._id,
      teamName: team.teamName,
      teamTag: team.teamTag,
      teamLogo: team.teamLogo,
      slot: team.slot,
      placePoints: team.placePoints,
      players: (team.players || []).map(p => {
        const slim = { uId: p.uId, _id: p._id, playerName: p.playerName, picUrl: p.picUrl };
        for (const f of SUMMARY_PLAYER_FIELDS) slim[f] = p[f];
        return slim;
      }),
    })),
  };
}

// ─── Live-tick team diffing ────────────────────────────────────────────────
// Keyed by matchId -> Map(teamId -> fingerprint string). Lets the socket-
// triggered ("liveUpdate") path send only the team(s) that actually changed
// since the last live push for that match, instead of re-embedding every
// team's full roster on every tick. Cleared whenever a match stops being
// live-pushed to for a while by simple LRU-less eviction isn't needed here —
// entries are small (one string per team) and naturally bounded by however
// many matches are actively live at once.
const lastSentTeamsByMatch = new Map();

function fingerprintTeam(team) {
  const parts = [team.placePoints];
  (team.players || []).forEach(p => {
    for (const f of NUMERIC_PLAYER_FIELDS) parts.push(p[f]);
  });
  return parts.join('|');
}

// ─── Live-tick overall diffing ─────────────────────────────────────────────
// Same idea as lastSentTeamsByMatch above, but for the round-wide cumulative
// standings (getOverallForRound). Without this, every single live-stat tick
// for whichever match is currently live would re-embed and re-broadcast the
// full cumulative teams+players object for the ENTIRE round (every match
// played so far), even though those totals only actually move when a team's
// placement/wwcd settles at match end.
const lastSentOverallByRound = new Map();

function fingerprintOverallTeam(team) {
  const parts = [team.placePoints, team.wwcd, team.matchesPlayed, team.slot];
  (team.players || []).forEach(p => {
    // SUMMARY_PLAYER_FIELDS, not NUMERIC_PLAYER_FIELDS — the aggregated
    // player object built by buildInitialAggPlayer only ever has these
    // fields now. NUMERIC_PLAYER_FIELDS stays reserved for fingerprintTeam
    // (the separate, untouched real-time matchData diff below).
    for (const f of SUMMARY_PLAYER_FIELDS) parts.push(p[f]);
  });
  return parts.join('|');
}

// Mutates overallData in place: keeps only the teams whose cumulative
// fingerprint differs from what was last sent for this round, and marks the
// payload as partial so the frontend knows to merge rather than replace.
function applyLiveOverallDiff(roundId, overallData) {
  if (!roundId || !overallData?.teams) return overallData;

  const key = roundId.toString();
  let lastSent = lastSentOverallByRound.get(key);
  if (!lastSent) {
    lastSent = new Map();
    lastSentOverallByRound.set(key, lastSent);
  }

  const changedTeams = overallData.teams.filter(team => {
    const teamKey = team.teamId?.toString();
    if (!teamKey) return true;
    const fp = fingerprintOverallTeam(team);
    const changed = lastSent.get(teamKey) !== fp;
    lastSent.set(teamKey, fp);
    return changed;
  });

  overallData.teams = changedTeams;
  overallData.isPartialTeams = true;
  return overallData;
}

// ─── Live-tick matches-list diffing ────────────────────────────────────────
// matchesData.list only changes via the separate Match change stream (new
// match, matchNo edit, group reassignment) — it's essentially static across
// the many MatchData live ticks that happen in between. Skip re-sending it
// on ticks where nothing actually changed.
const lastSentMatchesListByRound = new Map();

function fingerprintMatchesList(matches) {
  return matches
    .map(m => [m._id, m.matchNo, m.groupName, (m.groupNames || []).join(',')].join(':'))
    .join('|');
}

// Mutates matchData in place: when liveUpdate, keeps only the teams whose
// fingerprint differs from what was last sent for this match, and marks the
// payload as partial so the frontend knows to merge rather than replace. A
// match with no prior entry (first live push, or the map was never
// populated by a full/non-live fetch) sends everything once, then trims to
// deltas from then on.
function applyLiveTeamDiff(matchId, matchData) {
  if (!matchId || !matchData?.teams) return matchData;

  const key = matchId.toString();
  let lastSent = lastSentTeamsByMatch.get(key);
  if (!lastSent) {
    lastSent = new Map();
    lastSentTeamsByMatch.set(key, lastSent);
  }

  const changedTeams = matchData.teams.filter(team => {
    const teamKey = (team.teamId ?? team._id)?.toString();
    if (!teamKey) return true;
    const fp = fingerprintTeam(team);
    const changed = lastSent.get(teamKey) !== fp;
    lastSent.set(teamKey, fp);
    return changed;
  });

  matchData.teams = changedTeams;
  matchData.isPartialTeams = true;
  return matchData;
}

function sumNumericFields(target, source, fields) {
  for (const f of fields) {
    target[f] = Number(target[f] || 0) + Number(source[f] || 0);
  }
}

// Only aggregates the identity + stat fields overallData's consumers
// actually read (confirmed across all 6 themes' OverAllData/OverallFrags/
// LiveStats/EventMvp/1st-2ndRunnerUp/HighlightPoints) — NOT the full
// NUMERIC_PLAYER_FIELDS list, which stays reserved for the real-time
// matchData live-diff path (fingerprintTeam/applyLiveTeamDiff).
function buildInitialAggPlayer(p) {
  const base = {
    uId: p.uId || '', _id: p._id, playerName: p.playerName || '', picUrl: p.picUrl || '',
  };
  for (const f of SUMMARY_PLAYER_FIELDS) base[f] = 0;
  return base;
}

/* --------------------------------------------------------------------
   IDENTITY HYDRATION CACHE
   -------------------------------------------------------------------- */
// Keyed by `${tournamentId}:${teamId/playerId}` — NOT just the raw id.
// Teams are a shared catalog reused across different users' tournaments,
// so a bare teamId/playerId key would let one tournament's cached identity
// (name/photo) silently bleed into a completely unrelated tournament that
// happens to reuse the same shared team. Scoping by tournamentId keeps each
// tournament's cached identity data isolated from every other one.
const playerIdentityCache = new Map(); // `${tournamentId}:${playerId}` -> { playerName, picUrl, showPicUrl }
const teamIdentityCache = new Map();   // `${tournamentId}:${teamId}`   -> { teamName, teamTag, teamLogo }

function hydrateMatchDataIdentity(matchData, tournamentId) {
  if (!matchData?.teams) return matchData;
  const scope = tournamentId?.toString() || 'unscoped';

  for (const team of matchData.teams) {
    const teamId = (team.teamId ?? team._id)?.toString();
    const teamKey = teamId ? `${scope}:${teamId}` : null;
    if (teamKey) {
      const isTeamComplete = Boolean(team.teamName && team.teamTag && team.teamLogo);
      if (isTeamComplete) {
        teamIdentityCache.set(teamKey, {
          teamName: team.teamName,
          teamTag: team.teamTag,
          teamLogo: team.teamLogo,
        });
      } else {
        const cached = teamIdentityCache.get(teamKey);
        if (cached) {
          if (!team.teamName) team.teamName = cached.teamName;
          if (!team.teamTag) team.teamTag = cached.teamTag;
          if (!team.teamLogo) team.teamLogo = cached.teamLogo;
        }
      }
    }

    for (const player of team.players || []) {
      const playerId = player._id?.toString();
      if (!playerId) continue;
      const pKey = `${scope}:${playerId}`;

      const isPlayerComplete = Boolean(player.playerName);
      if (isPlayerComplete) {
        playerIdentityCache.set(pKey, {
          playerName: player.playerName,
          picUrl: player.picUrl,
          showPicUrl: player.showPicUrl,
        });
      } else {
        const cached = playerIdentityCache.get(pKey);
        if (cached) {
          player.playerName = player.playerName || cached.playerName;
          player.picUrl = player.picUrl || cached.picUrl;
          player.showPicUrl = player.showPicUrl || cached.showPicUrl;
        }
      }
    }
  }

  return matchData;
}

/* --------------------------------------------------------------------
   DEAD TEAM LIST — real-time elimination tracking, computed server-side
   --------------------------------------------------------------------
   death: matchId -> {
     everAlive: Set<teamKey>,       // teams observed alive at least once
     dead: Set<teamKey>,            // teams currently considered eliminated
     deadAt: Map<teamKey, Date>,    // when each currently-dead team FIRST
                                     // transitioned into `dead` — cleared
                                     // if the team un-dies (ratchet
                                     // reversal below), so a later
                                     // re-death gets an honest fresh
                                     // timestamp instead of reusing the
                                     // original one.
   }

   `rank` is read straight off the live-ingest-populated team.rank field
   (same source the rest of matchData.teams comes from) — this module
   doesn't compute or infer placement itself, just carries it through
   onto the dead-team snapshot alongside the identity/stat fields.
-------------------------------------------------------------------- */
const matchDeathState = new Map();

function isTeamAllDead(team) {
  return (
    Array.isArray(team.players) &&
    team.players.length > 0 &&
    team.players.every(p => p.liveState === 5 || p.bHasDied)
  );
}

function updateDeadTeamList(matchId, matchData) {
  if (!matchId || !matchData?.teams) return [];

  const stateKey = matchId.toString();
  let state = matchDeathState.get(stateKey);
  if (!state) {
    state = { everAlive: new Set(), dead: new Set(), deadAt: new Map(), rankAt: new Map() };
    matchDeathState.set(stateKey, state);
  }

  const totalTeams = matchData.teams.length;

  for (const team of matchData.teams) {
    const teamKey = (team.teamId ?? team._id)?.toString();
    if (!teamKey) continue;

    if (!isTeamAllDead(team)) {
      state.everAlive.add(teamKey);
      state.dead.delete(teamKey);
      state.deadAt.delete(teamKey);
      state.rankAt.delete(teamKey);
      continue;
    }

    if (state.everAlive.has(teamKey)) {
      if (!state.dead.has(teamKey)) {
        // First tick this team is seen dead in this life — stamp both
        // together. rank = teams still alive INCLUDING this one, at the
        // instant it died: total teams minus however many were already
        // dead before it (state.dead.size here is a snapshot taken
        // before this team is added below, so it's exactly "teams dead
        // before this one").
        state.deadAt.set(teamKey, new Date());
        state.rankAt.set(teamKey, totalTeams - state.dead.size);
      }
      state.dead.add(teamKey);
    }
  }

  return matchData.teams
    .filter(team => {
      const teamKey = (team.teamId ?? team._id)?.toString();
      return teamKey && state.dead.has(teamKey);
    })
    .map(team => {
      const teamKey = (team.teamId ?? team._id)?.toString();
      return {
        teamId: team.teamId ?? team._id,
        teamTag: team.teamTag,
        teamName: team.teamName,
        teamLogo: team.teamLogo,
        placePoints: team.placePoints,
        rank: state.rankAt.get(teamKey) ?? null,
        totalKills: (team.players || []).reduce((sum, p) => sum + (p.killNum || 0), 0),
        deadAt: state.deadAt.get(teamKey) ?? null,
      };
    });
}

/** Fetch matchData for an already-loaded match doc (no re-fetching the match). */
async function getMatchDataForMatchDoc(match) {
  if (!match) return null;

  let matchData = await MatchData.findOne({ matchId: match._id, userId: match.userId }).lean();
  if (!matchData) matchData = await MatchData.findOne({ matchId: match._id }).lean();
  if (!matchData) {
    try {
      const created = await createMatchDataForMatchDoc(match._id);
      matchData = created && created.toObject ? created.toObject() : created;
    } catch (err) {
      return null;
    }
  }

  matchData = hydrateMatchDataIdentity(matchData, match.tournamentId);
  matchData.deadTeamList = updateDeadTeamList(match._id, matchData);

  return matchData;
}

/** Fetch (or lazily create) the matchData doc for a single match, given only its id. */
async function getMatchDataForMatch(matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match) return null;
  return getMatchDataForMatchDoc(match);
}

/** Fetch matchData for a list of matches in parallel, keyed by matchId string. */
async function getMatchDataBatch(matches) {
  const results = await Promise.all(
    matches.map(m => getMatchDataForMatchDoc(m).catch(() => null))
  );
  const map = new Map();
  matches.forEach((m, i) => {
    if (results[i]) map.set(m._id.toString(), results[i]);
  });
  return map;
}

/**
 * Aggregate every match in a round into cumulative per-team / per-player totals.
 */
async function getOverallForRound(tournamentId, roundId, { matches: matchesIn, matchDataMap: matchDataMapIn } = {}) {
  const matches = matchesIn || await Match.find({ tournamentId, roundId }).sort({ matchNo: 1 }).lean();
  if (!matches.length) {
    return { tournamentId, roundId, totalMatches: 0, teams: [], createdAt: new Date() };
  }

  const matchDataMap = matchDataMapIn || await getMatchDataBatch(matches);

  const teamsMap = new Map();

  for (const m of matches) {
    const matchData = matchDataMap.get(m._id.toString());
    if (!matchData) continue;

    for (const team of matchData.teams || []) {
      const teamKey = team.teamId.toString();
      if (!teamsMap.has(teamKey)) {
        teamsMap.set(teamKey, {
          teamId: team.teamId, teamName: team.teamName || '', teamTag: team.teamTag || '',
          teamLogo: team.teamLogo || '', slot: Number.isFinite(team.slot) ? team.slot : 0,
          placePoints: 0, wwcd: 0, matchIds: new Set(), players: new Map(),
        });
      }
      const aggTeam = teamsMap.get(teamKey);
      if (!aggTeam.teamName && team.teamName) aggTeam.teamName = team.teamName;
      if (!aggTeam.teamTag && team.teamTag) aggTeam.teamTag = team.teamTag;
      if (!aggTeam.teamLogo && team.teamLogo) aggTeam.teamLogo = team.teamLogo;
      if (Number.isFinite(team.slot)) aggTeam.slot = Math.min(aggTeam.slot || team.slot, team.slot);
      aggTeam.placePoints += Number(team.placePoints || 0);
      if (Number(team.placePoints || 0) === 10) aggTeam.wwcd += 1;

      aggTeam.matchIds.add(m._id.toString());

      for (const p of team.players || []) {
        const pKey = p.uId || p._id.toString();
        if (!aggTeam.players.has(pKey)) aggTeam.players.set(pKey, buildInitialAggPlayer(p));
        const aggPlayer = aggTeam.players.get(pKey);
        if (p.playerName) aggPlayer.playerName = p.playerName;
        if (p.picUrl) aggPlayer.picUrl = p.picUrl;
        if (p.uId) aggPlayer.uId = p.uId;
        sumNumericFields(aggPlayer, p, SUMMARY_PLAYER_FIELDS);
      }
    }
  }

  const teams = Array.from(teamsMap.values())
    .map(t => ({
      teamId: t.teamId, teamName: t.teamName, teamTag: t.teamTag, teamLogo: t.teamLogo,
      slot: t.slot || 0, placePoints: t.placePoints, wwcd: t.wwcd,
      matchesPlayed: t.matchIds.size,
      players: Array.from(t.players.values()),
    }))
    .sort((a, b) => (a.slot || 0) - (b.slot || 0));

  return {
    tournamentId,
    roundId,
    totalMatches: matches.length,
    teams,
    createdAt: new Date(),
  };
}

async function buildBulkPayload({ tournamentId, roundId, matchId, view = null, followSelected = false, includeAll = false, liveUpdate = false }) {
  // liveUpdate: used only by the socket change-stream push (comsock.js) on
  // every live-stat write. Deliberately excludes needsAllMatchDatas — that
  // flag embeds EVERY match's full team/player rosters, which used to get
  // rebuilt and re-broadcast to every subscribed overlay socket on every
  // single tick regardless of which one match actually changed. Schedule/
  // overall views still get their lightweight data; only the redundant
  // whole-round roster re-embed is skipped here.
  const needsOverall = includeAll || liveUpdate || VIEWS_NEEDING_OVERALL.has(view);
  const needsMatchData = includeAll || liveUpdate || VIEWS_NEEDING_MATCH_DATA.has(view);
  const needsBackpack = includeAll || VIEWS_NEEDING_BACKPACK.has(view);
  const needsMatchesList = includeAll || liveUpdate || VIEWS_NEEDING_MATCHES_LIST.has(view);
  const needsAllMatchDatas = includeAll || VIEWS_NEEDING_ALL_MATCH_DATAS.has(view);

  const [tournament, round] = await Promise.all([
    Tournament.findById(tournamentId).lean(),
    Round.findById(roundId).lean(),
  ]);

  let effectiveMatchId = matchId || null;
  if (followSelected) {
    const selected = await MatchSelection.findOne({ tournamentId, roundId, isSelected: true })
      .sort({ createdAt: -1 })
      .lean();
    if (selected?.matchId) {
      effectiveMatchId = selected.matchId.toString();
    } else {
      const latest = await Match.findOne({ tournamentId, roundId }).sort({ matchNo: -1 }).lean();
      if (latest?._id) effectiveMatchId = latest._id.toString();
    }
  }

  const needsMatchesForLookup = needsMatchesList || needsAllMatchDatas || needsOverall;

  const matchPromise = effectiveMatchId ? Match.findById(effectiveMatchId).lean() : Promise.resolve(null);
  const groupsPromise = needsMatchesList
    ? Group.find({ tournamentId }).populate('slots.team').lean()
    : Promise.resolve(null);
  const matchesPromise = needsMatchesForLookup
    ? Match.find({ tournamentId, roundId }).sort({ matchNo: 1 }).lean()
    : Promise.resolve(null);

  const [match, groups, roundMatches] = await Promise.all([matchPromise, groupsPromise, matchesPromise]);

  let matchDataMap = null;
  if (roundMatches && (needsOverall || needsAllMatchDatas)) {
    matchDataMap = await getMatchDataBatch(roundMatches);
  }

  const matchDataPromise = needsMatchData && effectiveMatchId
    ? (matchDataMap && matchDataMap.has(effectiveMatchId)
        ? Promise.resolve(matchDataMap.get(effectiveMatchId))
        : getMatchDataForMatch(effectiveMatchId).catch(() => null))
    : Promise.resolve(null);

  const overallPromise = needsOverall
    ? getOverallForRound(tournamentId, roundId, { matches: roundMatches, matchDataMap }).catch(() => null)
    : Promise.resolve(null);

  const [matchData, overallData] = await Promise.all([matchDataPromise, overallPromise]);

  let enrichedMatches = [];
  if (roundMatches) {
    const groupMap = groups ? new Map(groups.map(g => [g._id.toString(), g.groupName])) : new Map();
    enrichedMatches = roundMatches.map(m => {
      if (groups && m.groups && m.groups.length > 0) {
        m.groupName = groupMap.get(m.groups[0].toString()) || 'Unknown';
        m.groupNames = m.groups.slice(0, 2).map(id => groupMap.get(id.toString()) || 'Unknown').filter(Boolean);
      } else if (groups) {
        m.groupName = 'Unknown';
        m.groupNames = [];
      }
      return m;
    });
  }

  const matchNoById = new Map(enrichedMatches.map(m => [m._id.toString(), m.matchNo]));

  let matchDatasData = [];
  if (needsAllMatchDatas && enrichedMatches.length > 0 && matchDataMap) {
    matchDatasData = enrichedMatches
      .map(m => {
        const md = matchDataMap.get(m._id.toString());
        if (!md) return null;
        return { matchId: m._id, matchNo: m.matchNo, matchData: slimMatchDataForList(md) };
      })
      .filter(Boolean);
  }

  // On live ticks, matchesData.list rarely differs from what was last sent
  // (it only really changes via the separate Match change stream), so skip
  // re-sending it when nothing changed. REST/includeAll/specific-view
  // fetches always get the full list.
  let matchesList = needsMatchesList ? enrichedMatches : [];
  let matchesListUnchanged = false;
  if (liveUpdate && needsMatchesList) {
    const listKey = `${tournamentId}:${roundId}`;
    const fp = fingerprintMatchesList(enrichedMatches);
    if (lastSentMatchesListByRound.get(listKey) === fp) {
      matchesList = [];
      matchesListUnchanged = true;
    } else {
      lastSentMatchesListByRound.set(listKey, fp);
    }
  }

  const matchesData = {
    list: matchesList,
    current: match,
    effectiveMatchId,
    ...(liveUpdate && needsMatchesList ? { listUnchanged: matchesListUnchanged } : {}),
  };

  // Only the socket-triggered live path gets trimmed to changed teams —
  // any real REST fetch (initial page load, manual refresh, includeAll,
  // or a specific `view`) always gets a complete matchData.teams so the
  // frontend never has to start from a partial picture.
  const finalMatchData = (liveUpdate && matchData)
    ? applyLiveTeamDiff(effectiveMatchId, matchData)
    : matchData;

  // On a live tick, needsAllMatchDatas is always false (see comment at the
  // top of this function), so matchDatasData would otherwise be sent as
  // `[]` on every single push — Schedule/HighlightSchedule/OverAllData/
  // OverallFrags/highlightPoints consumers must NOT treat that as "clear
  // everything" (see PublicThemeRenderer.tsx's merge-by-matchId handling).
  // Attach a lightweight single-entry update for just the match that
  // changed instead, reusing the already-fetched/diffed finalMatchData —
  // no extra query needed.
  if (matchDatasData.length === 0 && liveUpdate && finalMatchData && effectiveMatchId) {
    matchDatasData = [{
      matchId: effectiveMatchId,
      matchNo: match ? match.matchNo : (matchNoById.get(effectiveMatchId) ?? null),
      matchData: slimMatchDataForList(finalMatchData),
    }];
  }

  // Same treatment for the round-wide overall standings: only trim to
  // changed teams on the live-tick path, never on a real REST/full fetch.
  const finalOverallData = (liveUpdate && overallData)
    ? applyLiveOverallDiff(roundId, overallData)
    : overallData;

  const currentMatchData = finalMatchData
    ? {
        matchId: effectiveMatchId,
        matchNo: match ? match.matchNo : (matchNoById.get(effectiveMatchId) ?? null),
        matchData: finalMatchData,
      }
    : null;

  return {
    tournamentData: tournament || null,
    roundData: round || null,
    matchesData,
    matchDatasData,
    currentMatchData,
    overallData: finalOverallData || null,
    updatedAt: new Date(),
  };
}

async function getBulkData(req, res) {
  try {
    const { tournamentId, roundId, matchId } = req.params;
    const { view, followSelected, includeAll } = req.query;

    if (!mongoose.Types.ObjectId.isValid(tournamentId) || !mongoose.Types.ObjectId.isValid(roundId)) {
      return res.status(400).json({ error: 'Invalid tournamentId or roundId' });
    }

    const payload = await buildBulkPayload({
      tournamentId,
      roundId,
      matchId,
      view: view || null,
      followSelected: (followSelected || 'false').toLowerCase() === 'true',
      includeAll: includeAll ? includeAll.toLowerCase() === 'true' : !view,
    });

    if (!payload.tournamentData) {
      return res.status(404).json({ error: 'Tournament not found' });
    }

    res.json(payload);
  } catch (err) {
    console.error('Bulk data error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  buildBulkPayload,
  getBulkData,
  getMatchDataForMatch,
  getMatchDataForMatchDoc,
  getMatchDataBatch,
  getOverallForRound,
};