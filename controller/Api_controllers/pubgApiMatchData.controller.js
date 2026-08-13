const crypto = require('crypto');
const mongoose = require('mongoose');
const { decode } = require('@msgpack/msgpack');
const MatchSelection = require('../../models/MatchSelection.model');
const MatchData = require('../../models/matchData.model');
const Round = require('../../models/round.model');
const Group = require('../../models/group.model');
const User = require('../../models/User.model');
const updateTeamsWithApiPlayers = require('./playerCheckandSwitch');
const { getSocket } = require('../../socket');
const { computeOverallMatchDataForRound } = require('../overall.controller');
const { encodeMsgpack } = require('../../utils/msgpackCodec');
const { updateDeadTeamList } = require('../Bulkpublic.controller');

// ─── In-Memory Live Match Cache ───────────────────────────────────────────────
const liveMatchCache = new Map();

// ─── Group (roster) Cache ─────────────────────────────────────────────────────
// Group.find(...).populate('slots.team') was being re-run — populate
// round trip and all — on every single live tick, per match, per user, even
// though roster/group data changes rarely. Short TTL so a roster edit is
// still picked up within a few seconds.
//
// Stale-while-revalidate: on expiry, the stale cached value is returned
// IMMEDIATELY and the refetch happens in the background instead of being
// awaited inline. This function sits on updateMatchDataWithLiveStats's
// critical path, which the userProcessing gate holds ticks open for — a
// blocking cache-miss refetch every ~5s was a smaller-scale recurrence of
// the same failure mode fixed for computeOverallMatchDataForRound: a slow
// DB round trip on that one tick could exceed the ~2s PCOB gap and get that
// tick silently dropped. Only the very first call for a given key (nothing
// cached yet) still blocks, since there's no stale value to serve.
//
// Fetches ALL groups for (tournamentId, userId), not just one — a
// tournament can legitimately have multiple Group documents per user
// (e.g. "Group A" / "Group B", see group.controller.js's own
// Group.find({tournamentId, userId}) listing endpoint). A prior version
// used findOne here, which arbitrarily returned only one group; any team
// whose roster actually lived in a different group silently got treated
// as having an empty roster (groupPlayers = []) on every live tick,
// forever — no roster photo/name fallback ever available for that team's
// players, even though the roster data was correct. Fetching every group
// and merging their slots (see groupSlotByTeamId below) fixes that.
const GROUP_CACHE_TTL_MS = 5000;
const groupCache = new Map(); // `${tournamentId}:${userId}` -> { groups, expiresAt }
const groupRefreshInFlight = new Set(); // keys currently being refreshed in the background

async function fetchGroups(tournamentId, userId) {
  return Group.find({ tournamentId, userId }).populate('slots.team').lean();
}

function refreshGroupInBackground(key, tournamentId, userId) {
  if (groupRefreshInFlight.has(key)) return;
  groupRefreshInFlight.add(key);
  fetchGroups(tournamentId, userId)
    .then(groups => {
      groupCache.set(key, { groups, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
    })
    .catch(err => {
      console.warn(`[getGroupsCached] background refresh failed for ${key}:`, err.message);
    })
    .finally(() => {
      groupRefreshInFlight.delete(key);
    });
}

async function getGroupsCached(tournamentId, userId) {
  const key = `${tournamentId}:${userId}`;
  const cached = groupCache.get(key);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      refreshGroupInBackground(key, tournamentId, userId);
    }
    return cached.groups;
  }
  // First call ever for this key — nothing stale to serve, must block.
  const groups = await fetchGroups(tournamentId, userId);
  groupCache.set(key, { groups, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
  return groups;
}

// ─── API-Enabled Round IDs Cache ──────────────────────────────────────────────
// pollForUser (fired on every debounced socket tick) and
// discoverAndStartPollingUsers (every 10s) were each independently running
// the exact same Round.find({apiEnable:true}) query. Centralize it so the
// hot per-tick path reuses the same short-lived cache instead of paying its
// own round trip every tick.
// Shorter than the 10s discoverAndStartPollingUsers interval, so that
// periodic discovery run always re-queries fresh (keeping apiEnable
// toggles responsive) while ticks in between reuse the cached value.
const API_ENABLED_ROUNDS_TTL_MS = 8000;
let apiEnabledRoundIdsCache = null;
let apiEnabledRoundIdsCacheAt = 0;

async function getApiEnabledRoundIds() {
  if (apiEnabledRoundIdsCache && Date.now() - apiEnabledRoundIdsCacheAt < API_ENABLED_ROUNDS_TTL_MS) {
    return apiEnabledRoundIdsCache;
  }
  const apiEnabledRounds = await Round.find({ apiEnable: true }).select('_id').lean();
  apiEnabledRoundIdsCache = apiEnabledRounds.map(r => r._id.toString());
  apiEnabledRoundIdsCacheAt = Date.now();
  return apiEnabledRoundIdsCache;
}

// ─── Background Save Queue ────────────────────────────────────────────────────
const saveQueue = [];
let isSaving = false;

async function processSaveQueue() {
  if (isSaving || saveQueue.length === 0) return;
  isSaving = true;

  // Drain everything currently queued into a single bulk write instead of
  // one updateOne per job — turns N round trips into 1.
  const batch = saveQueue.splice(0, saveQueue.length);
  try {
    await MatchData.bulkWrite(
      batch.map(job => ({
        updateOne: {
          filter: { matchId: job.matchId, userId: job.userId },
          update: { $set: { teams: job.teams } },
        },
      })),
      { ordered: false }
    );
    console.log(c('green', `💾 Bulk-saved ${batch.length} job(s)`));
  } catch (err) {
    console.error('Background save error:', err.message);
  } finally {
    isSaving = false;
    // more jobs may have queued up while we were writing
    if (saveQueue.length > 0) processSaveQueue();
  }
}

// ─── One-time Index Setup ─────────────────────────────────────────────────────
const ensureIndexes = async () => {
  try {
    const db = mongoose.connection.db;

    await db.collection('matchdatas').createIndex(
      { matchId: 1, userId: 1 },
      { background: true, name: 'matchId_userId' }
    );
    await db.collection('matchselections').createIndex(
      { matchId: 1, isSelected: 1, userId: 1 },
      { background: true, name: 'matchId_isSelected_userId' }
    );
    await db.collection('matchselections').createIndex(
      { isSelected: 1, userId: 1, roundId: 1 },
      { background: true, name: 'isSelected_userId_roundId' }
    );
    await db.collection('matchselections').createIndex(
      { isSelected: 1, isPollingActive: 1, roundId: 1 },
      { background: true, name: 'isSelected_isPollingActive_roundId' }
    );
    await db.collection('rounds').createIndex(
      { apiEnable: 1 },
      { background: true, name: 'apiEnable' }
    );
    await db.collection('groups').createIndex(
      { tournamentId: 1, userId: 1 },
      { background: true, name: 'tournamentId_userId' }
    );

    console.log(c('green', '✔ MongoDB indexes ensured'));
  } catch (err) {
    console.warn('Index setup warning (non-fatal):', err.message);
  }
};

// ─── Console Logger Utility ───────────────────────────────────────────────────
const chalk = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',
  bgRed:    '\x1b[41m',
  bgGreen:  '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue:   '\x1b[44m',
};
const c = (color, text) => `${chalk[color]}${text}${chalk.reset}`;

// Full table dumps / diff tables are synchronous console writes on the hot
// emit path, running per tick per active match — console.log is a
// SYNCHRONOUS write whenever stdout is a non-TTY pipe (which it is on
// Render), so a slow/backed-up log drain there blocks the single Node
// event loop for every concurrently-running match, not just the one being
// logged. Opt-IN only (was opt-out, i.e. on by default, which is backwards
// for a hazard this severe) — set VERBOSE_MATCH_LOGS=true to get per-tick
// table/diff dumps for local debugging.
const VERBOSE_MATCH_LOGS = process.env.VERBOSE_MATCH_LOGS === 'true';

// ─── Log Diff ─────────────────────────────────────────────────────────────────
function logMatchDiff(matchId, lastData, currentData) {
  const timestamp = new Date().toLocaleTimeString();
  const changes = [];

  currentData.teams.forEach((team, ti) => {
    const lastTeam = lastData?.teams?.[ti];
    const tag = team.teamTag || team.teamName || `Slot${team.slot}`;

    if (lastTeam && team.placePoints !== lastTeam.placePoints) {
      changes.push({
        team: tag, slot: team.slot, player: '—', field: 'placePoints',
        old: lastTeam.placePoints, new: team.placePoints
      });
    }

    team.players?.forEach((player, pi) => {
      const lastPlayer = lastTeam?.players?.[pi];
      const TRACKED = [
        'killNum', 'health', 'damage', 'assists', 'knockouts',
        'liveState', 'bHasDied', 'headShotNum', 'survivalTime',
        'rescueTimes', 'inDamage', 'heal', 'rank',
      ];
      TRACKED.forEach(field => {
        const newVal = player[field];
        const oldVal = lastPlayer?.[field];
        if (oldVal !== undefined && newVal !== oldVal) {
          changes.push({
            team: tag,
            slot: team.slot,
            player: player.playerName || player.uId,
            field,
            old: oldVal,
            new: newVal
          });
        }
      });
    });
  });

  if (!changes.length) {
    console.log(`${c('dim', timestamp)} ${c('yellow', '≈')} match=${matchId} — no stat changes`);
    return;
  }

  console.log(`\n${c('bgBlue', c('bold', ` LIVE UPDATE `))} ${c('cyan', matchId)} ${c('dim', `@ ${timestamp}`)}`);
  console.log(c('dim', '─'.repeat(80)));

  const W = { slot: 4, team: 8, player: 18, field: 22, old: 10, new: 10 };
  const row = (slot, team, player, field, oldV, newV) =>
    `  ${String(slot).padStart(W.slot)}  ${String(team).padEnd(W.team)}  ${String(player).padEnd(W.player)}  ${String(field).padEnd(W.field)}  ${String(oldV).padStart(W.old)}  →  ${String(newV).padEnd(W.new)}`;

  console.log(c('dim', row('Slot', 'Team', 'Player', 'Field', 'Before', 'After')));
  console.log(c('dim', '─'.repeat(80)));

  changes.forEach(ch => {
    const isGood   = ['killNum', 'assists', 'knockouts', 'headShotNum', 'heal', 'rescueTimes'].includes(ch.field);
    const isBad    = ['bHasDied', 'liveState'].includes(ch.field) && ch.new > ch.old;
    const isHealth = ch.field === 'health';

    let colored;
    if (isBad)
      colored = c('red',    row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else if (isGood)
      colored = c('green',  row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else if (isHealth && ch.new < ch.old)
      colored = c('yellow', row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new));
    else
      colored = row(ch.slot, ch.team, ch.player, ch.field, ch.old, ch.new);

    console.log(colored);
  });

  console.log(c('dim', '─'.repeat(80)));
  console.log(`  ${c('bold', String(changes.length))} change(s) detected\n`);
}

// ─── Log Full Table ───────────────────────────────────────────────────────────
function logFullMatchTable(matchData) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n${c('bgGreen', c('bold', ` MATCH SNAPSHOT `))} ${c('cyan', String(matchData.matchId))} ${c('dim', `@ ${timestamp}`)}`);
  console.log(c('dim', '─'.repeat(110)));

  const hdr =
    `  ${'Sl'.padStart(2)}  ${'Team'.padEnd(8)}  ${'Player'.padEnd(18)}` +
    `  ${'HP'.padStart(4)}  ${'Kills'.padStart(5)}  ${'Dmg'.padStart(6)}` +
    `  ${'Assists'.padStart(7)}  ${'KO'.padStart(3)}  ${'State'.padStart(5)}` +
    `  ${'Rank'.padStart(4)}  ${'Died'.padStart(5)}`;
  console.log(c('dim', hdr));
  console.log(c('dim', '─'.repeat(110)));

  matchData.teams?.forEach(team => {
    const tag = team.teamTag || team.teamName || `Slot${team.slot}`;
    team.players?.forEach((p, i) => {
      const died = p.bHasDied ? c('red', 'DEAD ') : c('green', 'ALIVE');
      const hp =
        p.health <= 30 ? c('red',    String(p.health || 0).padStart(4)) :
        p.health <= 70 ? c('yellow', String(p.health || 0).padStart(4)) :
                         String(p.health || 0).padStart(4);
      const line =
        `  ${String(team.slot).padStart(2)}` +
        `  ${(i === 0 ? tag : '').padEnd(8)}` +
        `  ${(p.playerName || p.uId || '?').padEnd(18)}` +
        `  ${hp}` +
        `  ${String(p.killNum   || 0).padStart(5)}` +
        `  ${String(p.damage    || 0).padStart(6)}` +
        `  ${String(p.assists   || 0).padStart(7)}` +
        `  ${String(p.knockouts || 0).padStart(3)}` +
        `  ${String(p.liveState || 0).padStart(5)}` +
        `  ${String(p.rank      || 0).padStart(4)}` +
        `  ${died}`;
      console.log(line);
    });
  });

  console.log(c('dim', '─'.repeat(110)) + '\n');
}

// ─── Per-User Live Player Cache (pushed via socket from each user's local relay) ─
// This replaces the old single global `latestApiPlayers`. Each connected relay
// socket is bound to a userId on a `registerRelay` handshake, and its pushes
// are stored keyed by that userId — so N users' relays running at the same
// time no longer stomp on each other's data.
const liveApiPlayersByUser = new Map(); // userId -> { players, at }

// ─── Relay Wire-Protocol State (delta + sequence-number tracking) ────────────
// The relay (fetcher.rs) now sends totalPlayerList as either a full roster
// (isFull:true) or a DELTA of only new/changed players (isFull:false), each
// tagged with a monotonic wireSeq. This map is the single source of truth for
// that protocol per user: which socket is currently authoritative, the
// highest wireSeq applied, and the merged player set (keyed by uid) that
// liveApiPlayersByUser is rebuilt from after every message.
//
// Keyed by userId (matching how liveApiPlayersByUser/downstream consumption
// is keyed), but every write is gated on the incoming packet's own socket.id
// matching .socketId — that comparison is what rejects a stale, already-
// evicted connection's late-arriving packet (registerRelay's eviction loop
// calls s.disconnect(true) on the old socket, but that does not retroactively
// cancel a 'totalPlayerList' callback already queued on the event loop for
// it). Reset wholesale on every registerRelay (fresh connection or
// reconnect), so a connection swap never inherits stale seq/player state.
const relayStateByUser = new Map(); // userId -> { socketId, lastReceivedSeq, players: Map<uid, playerObj> }

// Mirrors fetcher.rs's player_key(): prefer uId, fall back to playerName.
function playerKeyOf(p) {
  if (p == null) return null;
  if (p.uId !== undefined && p.uId !== null && p.uId !== '') return String(p.uId);
  if (p.playerName) return String(p.playerName);
  return null;
}

// PCOB uses -1 as a "not populated yet" sentinel on at least `rank` (only
// assigned once a player/team is eliminated) — possibly other stat fields
// too. Plain `x || 0` doesn't catch it since -1 is truthy, so it was
// leaking straight through to persisted/broadcast player data and showing
// up as a literal "-1" on the overlay. Clamp explicitly at ingestion.
const nonNeg = (v) => (typeof v === 'number' && v > 0) ? v : 0;

// ─── Cheap Fingerprinting (replaces full-object MD5 hashing on hot path) ─────
// Hashing the entire match object (including location/inventory noise) on
// every tick is wasted CPU. We only care about the fields logMatchDiff
// actually tracks, so fingerprint just those.
const TRACKED_FIELDS = [
  'killNum', 'health', 'damage', 'assists', 'knockouts',
  'liveState', 'bHasDied', 'headShotNum', 'survivalTime',
  'rescueTimes', 'inDamage', 'heal', 'rank',
];

// Returns the raw parts array instead of hashing it — comparing two arrays
// element-by-element is cheaper than an MD5 digest on every tick, and we
// avoid a crypto call entirely on the (very common) no-change tick.
function computeFingerprintParts(matchData) {
  const parts = [];
  matchData.teams?.forEach(team => {
    parts.push(team.placePoints);
    team.players?.forEach(p => {
      for (const f of TRACKED_FIELDS) parts.push(p[f]);
    });
  });
  return parts;
}

function fingerprintsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Same idea as computeFingerprintParts, but over computeOverallMatchDataForRound's
// aggregated output — the per-tick match fingerprint gates whether we recompute
// the aggregate at all, but the aggregate itself was still resent even when
// identical to what was last sent (e.g. a tick that only changed a non-numeric
// field like `character` moves the match fingerprint but not the cumulative
// totals). This second gate skips that redundant `overallDataUpdate` emit.
function computeOverallFingerprintParts(teams) {
  const parts = [];
  (teams || []).forEach(team => {
    parts.push(team.placePoints, team.wwcd, team.matchesPlayed);
    (team.players || []).forEach(p => {
      for (const f of TRACKED_FIELDS) parts.push(p[f]);
    });
  });
  return parts;
}

const lastOverallFingerprintByUserMatch = {};

// Guards computeOverallMatchDataForRound (round-wide standings recompute —
// scans every MatchData in the round and re-aggregates every player) from
// running twice in parallel for the same match. This is NOT what gates
// userProcessing/tick acceptance below — it's fire-and-forget precisely so
// a slow round-wide recompute can never block the next live tick from being
// accepted (see emitUpdates).
const overallRecomputeInFlight = new Set(); // cacheKey (userKey:matchId)

// ─── Event Debounce / Concurrency Guards ──────────────────────────────────────
const EVENT_DEBOUNCE_MS = 150;   // coalesce bursts of rapid game-tick pushes per user

// Leading+trailing, not pure trailing-edge: PCOB ticks arrive ~2s apart in
// the common case (isolated, not bursty), so a plain trailing-edge debounce
// (fire only after EVENT_DEBOUNCE_MS of silence) made almost every tick pay
// the full delay for no coalescing benefit. Firing immediately on the first
// tick after being idle (leading edge) removes that delay for the common
// case, while a single trailing fire still coalesces genuine bursts exactly
// as before.
const debounceStateByUser = new Map(); // userId -> { timer, pendingTrailing }

// userId -> boolean. Presence in the map means a run is currently in
// flight; the boolean value is a "rerun once more when this finishes" flag
// — same size-1 coalescing pattern as debounceStateByUser's pendingTrailing
// above. Previously a plain Set used as a drop-gate: a tick that arrived
// while the previous one was still running (e.g. a momentary Atlas latency
// spike, a cold cache-miss) was thrown away outright rather than delayed,
// so the viewer had to wait for the NEXT raw PCOB tick (~2s later) to catch
// up — reading as an irregular stall rather than a steady cadence. Now it
// just gets coalesced into one immediate follow-up run instead of lost.
const userProcessing = new Map();

// ─── Active User Tracking ───────────────────────────────────────────────────
// Populated purely by discovery of active MatchSelections in the DB — no
// per-user timers/intervals live here anymore. It's just "who should we
// update when the next socket push arrives".
const activeUserKeys = new Set();
const userKeyToDbId = new Map();
const lastMatchDataByUserMatch = {};
const lastFingerprintByUserMatch = {}; // stores fingerprint PARTS arrays, not hashes

// socket.id -> userId, so disconnect can clean up the right entries
const socketIdToUserId = new Map();

// ─── Binary Payload Decode Helper ──────────────────────────────────────────
// The relay now sends 'totalPlayerList' as MessagePack-encoded binary
// (Payload::Binary on the Rust side, via rmp_serde::to_vec_named) instead
// of plain JSON, to cut wire size/CPU on the hot live-tick path. Socket.IO
// hands binary attachments back here as a Buffer (Node) — decode() from
// @msgpack/msgpack accepts a Buffer/Uint8Array/ArrayBuffer directly.
//
// Kept permissive on purpose: if a raw JS object ever comes through
// instead (e.g. an older un-updated relay build still emitting JSON, or a
// dev/test client), we pass it through unchanged rather than throwing —
// so this one handler keeps working across a mixed-version rollout
// instead of requiring every relay to update in lockstep with this server.
function decodeTotalPlayerListPayload(raw) {
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
    return decode(raw);
  }
  // Already a plain object/array — nothing to decode (back-compat path).
  return raw;
}

// ─── Main Updater ─────────────────────────────────────────────────────────────
function startLiveMatchUpdater() {
  const io = getSocket();
  console.log('Socket.IO instance connected:', !!io);

  // ── Receive live player data pushed from each user's local relay ───────────
  io.on('connection', (socket) => {
    console.log(c('dim', `[socket] client connected: ${socket.id}`));

    // A cookie-bearing client (the dashboard) already has a verified
    // session by the time the socket handshake completes (io.engine.use
    // shares the same session middleware as Express) — auto-join it to its
    // own room so it receives the user-scoped liveMatchUpdate/
    // overallDataUpdate emits below without needing the relay's separate
    // token handshake (the relay has no cookie to present; this does).
    // Deliberately does not set socket.data.userId — that stays reserved
    // for the relay's own registration/eviction logic.
    const sessionUserId = socket.request.session?.userId;
    if (sessionUserId) {
      socket.join(`user:${sessionUserId}`);
      console.log(c('cyan', `[socket] dashboard auto-joined room user:${sessionUserId} (${socket.id})`));
    }

    // Each relay identifies which user it belongs to before pushing data.
    // The relay has no session cookie to present (it's a bare WebSocket
    // connection from the desktop app, not a browser), so it can't reuse
    // the normal session-auth path — instead it presents the opaque
    // relayToken issued at login, and we resolve the real userId from
    // that server-side. A client-supplied userId is never trusted directly:
    // that's what let anyone claim to be any user, evict their live relay,
    // and inject fake stats into their overlay.
    //
    // NOTE: registerRelay itself is unaffected by the msgpack change — the
    // Rust side still emits it as a plain JSON object ({ relayToken }),
    // so this handler keeps receiving a normal JS object here.
    socket.on('registerRelay', async ({ relayToken } = {}) => {
  if (!relayToken) {
    console.warn(c('yellow', `[socket] registerRelay from ${socket.id} missing relayToken`));
    return;
  }

  const user = await User.findOne({ relayToken }).select('_id').lean();
  if (!user) {
    console.warn(c('yellow', `[socket] registerRelay from ${socket.id} presented an unknown relayToken`));
    return;
  }
  const key = String(user._id);

  // Evict any other socket already registered for this same user — this is
  // what happens when the app restarts without a clean disconnect: the old
  // socket lingers on Render and keeps pushing stale data until the new one
  // shows up. Force it closed immediately instead of waiting on a timeout.
  for (const [id, s] of io.sockets.sockets) {
    if (id !== socket.id && s.data?.userId === key) {
      console.log(c('yellow', `[socket] evicting stale relay ${id} for user ${key} (superseded by ${socket.id})`));
      s.disconnect(true);
    }
  }

  socket.data.userId = key;
  socketIdToUserId.set(socket.id, key);
  socket.join(`user:${key}`);

  // Every registration — first-ever OR a reconnect replacing a stale
  // connection — rebinds socketId and resets lastReceivedSeq (so gap
  // detection doesn't misjudge the new connection's sequence numbering
  // against an old baseline), and forces an immediate full resync
  // rather than waiting for the relay's next natural tick or for a
  // gap to be detected.
  //
  // Deliberately PRESERVES the existing accumulated `players` Map
  // (if any) rather than resetting it to empty. A prior version reset
  // it here, which opened a window between this reset and the
  // requested full snapshot's response actually arriving: if any tick
  // — even a partial delta — landed in that window,
  // updateMatchDataWithLiveStats would unconditionally rebuild every
  // team's players array from that incomplete apiPlayers set (it does
  // this every tick, no backfill), wiping out previously-known players
  // (including ones no longer actively changing, e.g. already dead)
  // and persisting that empty roster straight to MatchData. Preserving
  // the map means the worst case during the resync window is
  // stale-but-present data, never a false disappearance — matching how
  // staleness is handled everywhere else in this pipeline. The eventual
  // full-snapshot response still wholesale-replaces this map as before
  // (see the totalPlayerList handler's isFull branch), so a genuine
  // reset (e.g. a real new match) is unaffected.
  const existing = relayStateByUser.get(key);
  relayStateByUser.set(key, {
    socketId: socket.id,
    lastReceivedSeq: null,
    players: existing?.players ?? new Map(),
  });
  socket.emit('requestFullSnapshot');

  console.log(c('cyan', `[socket] relay registered → user ${key} (${socket.id})`));
});

    socket.on('totalPlayerList', (raw) => {
      const userId = socket.data.userId;
      if (!userId) {
        console.warn(c('yellow', `[socket] totalPlayerList from unregistered socket ${socket.id} — ignored`));
        return;
      }

      // Reject a packet from a socket that isn't the currently-registered
      // one for this user. registerRelay's eviction loop calls
      // s.disconnect(true) on a superseded connection, but that does not
      // retroactively cancel a 'totalPlayerList' callback already queued
      // on the event loop for it — without this check, a stale packet
      // could land AFTER the new connection has already reset
      // relayStateByUser, corrupting its fresh seq/player baseline.
      const state = relayStateByUser.get(userId);
      if (!state || state.socketId !== socket.id) {
        console.warn(
          c('yellow', `[socket] totalPlayerList from STALE/evicted socket ${socket.id} (user=${userId}, active=${state?.socketId ?? 'none'}) — ignored`)
        );
        return;
      }

      // Decode the MessagePack binary payload back into a plain object
      // before anything else touches it.
      let data;
      try {
        data = decodeTotalPlayerListPayload(raw);
      } catch (e) {
        console.error(c('red', `[socket] failed to decode msgpack totalPlayerList from ${socket.id} (user=${userId}): ${e.message}`));
        return;
      }

      const incomingPlayers = Array.isArray(data?.playerInfoList) ? data.playerInfoList
        : Array.isArray(data) ? data : [];
      const wireSeq = typeof data?.wireSeq === 'number' ? data.wireSeq : null;
      // No wireSeq at all ⇒ an un-updated relay build that always sends
      // the complete roster with no isFull flag — treat as full for
      // back-compat during a mixed-version rollout, regardless of
      // data.isFull's value.
      const isFull = data?.isFull === true || wireSeq === null;

      if (isFull) {
        // Never regress: the pending-retry path on the relay can deliver a
        // full snapshot for an "old" wireSeq well after newer deltas (or
        // another full snapshot) already landed — the relay has several
        // independent full-snapshot senders (resume-push, requestFullSnapshot's
        // own response, a new-match reset, and a background retry loop that
        // can take minutes to finally land), any of which can arrive out of
        // order. Unlike the delta branch below, this used to apply
        // unconditionally regardless of ordering, silently reverting
        // health/liveState/bHasDied/etc. for every player it contained —
        // the source of the rapid dead/alive-and-health-flicker bug. Now it
        // gets the same "don't regress already-applied state" treatment:
        // a stale full snapshot only backfills players not already known,
        // it never overwrites fresher data.
        const isStaleFull = wireSeq != null && state.lastReceivedSeq != null && wireSeq < state.lastReceivedSeq;
        if (isStaleFull) {
          for (const p of incomingPlayers) {
            const uid = playerKeyOf(p);
            if (uid != null && !state.players.has(uid)) state.players.set(uid, p);
          }
          console.debug(`[socket] stale full snapshot (wireSeq=${wireSeq} < ${state.lastReceivedSeq}) user=${userId} — merged unseen players only, did not overwrite`);
        } else {
          state.players = new Map();
          for (const p of incomingPlayers) {
            const uid = playerKeyOf(p);
            if (uid != null) state.players.set(uid, p);
          }
        }
        if (wireSeq != null) {
          state.lastReceivedSeq = state.lastReceivedSeq == null
            ? wireSeq
            : Math.max(state.lastReceivedSeq, wireSeq);
        }
      } else {
        if (state.lastReceivedSeq != null && wireSeq <= state.lastReceivedSeq) {
          // Stale/out-of-order-low delta (e.g. a slow retry attempt that
          // finally landed after fresher ticks already arrived) — drop
          // it rather than risk regressing a monotonically-increasing
          // stat field backward. Whatever it had is already superseded.
          console.debug(`[socket] dropping out-of-order-low delta (wireSeq=${wireSeq}, already at ${state.lastReceivedSeq}) user=${userId}`);
          return;
        }
        const expected = state.lastReceivedSeq == null ? null : state.lastReceivedSeq + 1;
        if (expected !== null && wireSeq !== expected) {
          console.warn(
            c('yellow', `[socket] totalPlayerList GAP user=${userId}: expected wireSeq ${expected}, got ${wireSeq} — requesting resync`)
          );
          socket.emit('requestFullSnapshot');
          // Still merge what DID arrive below — don't discard useful
          // partial data while the resync is in flight.
        }
        for (const p of incomingPlayers) {
          const uid = playerKeyOf(p);
          if (uid != null) state.players.set(uid, p); // update-in-place/insert, never remove
        }
        state.lastReceivedSeq = wireSeq;
      }

      const players = Array.from(state.players.values());
      liveApiPlayersByUser.set(userId, { players, at: Date.now() });

      console.log(
        `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
        `${c('cyan', '📡 received totalPlayerList')} ` +
        `(${c('bold', String(incomingPlayers.length))}/${players.length} players, ${isFull ? 'full' : 'delta'}, wireSeq=${wireSeq ?? 'n/a'}) user=${userId} socket=${socket.id}`
      );

      // Leading+trailing per user: bursts from ONE user's relay still
      // coalesce (trailing fire), but an isolated tick (the common case at
      // PCOB's ~2s cadence) fires immediately instead of always paying the
      // full EVENT_DEBOUNCE_MS delay for no coalescing benefit.
      const debounceState = debounceStateByUser.get(userId);
      if (!debounceState) {
        triggerImmediateUpdateForUser(userId).catch(err =>
          console.error(`[trigger] user ${userId} error:`, err)
        );
        const timer = setTimeout(() => {
          const s = debounceStateByUser.get(userId);
          debounceStateByUser.delete(userId);
          if (s && s.pendingTrailing) {
            triggerImmediateUpdateForUser(userId).catch(err =>
              console.error(`[trigger] user ${userId} error:`, err)
            );
          }
        }, EVENT_DEBOUNCE_MS);
        debounceStateByUser.set(userId, { timer, pendingTrailing: false });
      } else {
        debounceState.pendingTrailing = true;
      }
    });

    // Public overlay room join — anonymous, no auth (mirrors the old
    // joinBulkRoom/leaveBulkRoom from comsock.js). Scoped per round rather
    // than per match so a followSelected overlay keeps receiving whichever
    // match is currently selected, without needing to rejoin on a switch.
    socket.on('joinRoundRoom', ({ tournamentId, roundId } = {}) => {
      if (!tournamentId || !roundId) return;
      socket.join(`round:${tournamentId}:${roundId}`);
    });

    socket.on('leaveRoundRoom', ({ tournamentId, roundId } = {}) => {
      if (!tournamentId || !roundId) return;
      socket.leave(`round:${tournamentId}:${roundId}`);
    });

    socket.on('disconnect', () => {
      console.log(c('dim', `[socket] client disconnected: ${socket.id}`));
      const userId = socketIdToUserId.get(socket.id);
      socketIdToUserId.delete(socket.id);
      if (!userId) return;

      // Only clear relay wire-protocol state if THIS was the currently-
      // authoritative connection for the user — a belated disconnect from
      // an already-evicted/superseded socket must not clobber a newer
      // connection's already-registered seq/player state.
      const relayState = relayStateByUser.get(userId);
      if (relayState && relayState.socketId === socket.id) {
        relayStateByUser.delete(userId);
      }

      // Only clear this user's live-data state if no other socket (e.g. a
      // reconnect already in flight, or a second device) still claims them.
      const stillConnected = [...io.sockets.sockets.values()]
        .some(s => s.id !== socket.id && s.data?.userId === userId);

      if (!stillConnected) {
        liveApiPlayersByUser.delete(userId);
        const debounceState = debounceStateByUser.get(userId);
        if (debounceState) {
          clearTimeout(debounceState.timer);
          debounceStateByUser.delete(userId);
        }
        console.log(c('dim', `[socket] cleared relay state for user ${userId}`));
      }
    });
  });

  if (mongoose.connection.readyState === 1) {
    ensureIndexes();
  } else {
    mongoose.connection.once('open', ensureIndexes);
  }

  // Ticks slower than this get an always-on (not gated by VERBOSE_MATCH_LOGS)
  // warning logged, so remaining latency variance is measurable in
  // production instead of guessed at. Deliberately just one line per slow
  // pass, not a per-field table — cheap enough to leave on permanently.
  const SLOW_POLL_THRESHOLD_MS = 500;

  // ── Fired on every debounced socket push, scoped to ONE user ────────────
  // Size-1 coalescing: if a new tick arrives while a previous one for this
  // user is still running, it doesn't get dropped — it flags "run once more
  // immediately after this finishes" (same pattern as debounceStateByUser's
  // pendingTrailing above), so a single slow pass costs at most one extra
  // immediate re-run instead of a full ~2s wait for the next raw PCOB tick.
  async function triggerImmediateUpdateForUser(userId) {
    if (!activeUserKeys.has(userId)) return; // not an active/polling user — ignore
    if (userProcessing.has(userId)) {
      userProcessing.set(userId, true);
      return;
    }
    userProcessing.set(userId, false);
    try {
      do {
        userProcessing.set(userId, false);
        const startedAt = Date.now();
        await pollForUser(userId);
        const elapsed = Date.now() - startedAt;
        if (elapsed > SLOW_POLL_THRESHOLD_MS) {
          console.warn(`[perf] pollForUser(${userId}) took ${elapsed}ms`);
        }
      } while (userProcessing.get(userId));
    } finally {
      userProcessing.delete(userId);
    }
  }

  // ─── Core Match Update ──────────────────────────────────────────────────────
  const updateMatchDataWithLiveStats = async (matchId, userId, apiPlayers, apiPlayersAt) => {
    // These two queries don't depend on each other — run in parallel.
    // Both .lean() — matchData is never saved directly here (writes go
    // through the bulkWrite saveQueue below), so the Mongoose document
    // hydration/change-tracking overhead was paid every ~2s tick for
    // nothing; team mutations below just operate on the plain object.
    const [matchData, selectedMatch] = await Promise.all([
      MatchData.findOne({ matchId, userId }).lean(),
      MatchSelection.findOne({ matchId, isSelected: true, userId }).lean(),
    ]);

    if (!matchData) {
      console.log('No MatchData found for matchId:', matchId);
      return null;
    }

    const tournamentId = selectedMatch?.tournamentId;
    if (!tournamentId) {
      console.log('Cannot find tournamentId for matchId:', matchId);
      return null;
    }

    const groups = await getGroupsCached(tournamentId, userId);
    if (!groups || groups.length === 0) {
      console.log('No group found for tournament:', tournamentId.toString());
      return null;
    }

    if (!apiPlayers?.length) {
      console.warn(`⚠️  No live player data received via socket yet for user=${userId} — skipping this cycle`);
      return matchData;
    }

    const STALE_MS = 15000;
    if (apiPlayersAt && Date.now() - apiPlayersAt > STALE_MS) {
      console.warn(
        `⚠️  Player data is stale (${Math.round((Date.now() - apiPlayersAt) / 1000)}s old) for user=${userId} — relay may be disconnected`
      );
    }

    const normalizeId = id => (id ? String(id).trim() : '');

    // Pre-index every group's slots by team _id once, instead of a linear
    // `slots.find(...)` scan per team below (was O(teams × slots)). Spans
    // ALL groups for this tournament+user (not just one) — a team's
    // roster can live in any of them (e.g. "Group A"/"Group B"), and a
    // team is only ever expected to appear in one group's slots, so
    // flattening across groups carries no meaningful collision risk.
    const groupSlotByTeamId = new Map();
    for (const g of groups) {
      for (const s of g.slots || []) {
        if (s.team?._id) groupSlotByTeamId.set(s.team._id.toString(), s);
      }
    }

    // groupPlayers per team — used only to enrich a live player's
    // name/photo/openId (see the matchPlayer/grpPlayer lookups below),
    // never for team routing.
    const teamGroupPlayers = new Map(); // teamId (string) -> groupPlayers[]
    for (const t of matchData.teams) {
      const gSlot = groupSlotByTeamId.get(t.teamId.toString());
      teamGroupPlayers.set(String(t.teamId), gSlot?.team?.players || []);
    }

    // Team routing is a pure function of THIS tick: every apiPlayer sharing
    // the same live apiPlayer.teamId is one in-game squad, grouped together
    // and attached, as a whole, to the ONE tournament team whose slot
    // number equals that teamId. Deterministic and stateless — unlike a
    // roster/continuity-based resolver, nothing here depends on what a
    // previous tick (or the roster) decided, so a bad read can never get
    // permanently "stuck": every tick re-derives fresh from the live
    // payload.
    const apiPlayersByTeamId = new Map(); // Number(apiTeamId) -> apiPlayer[]
    for (const p of apiPlayers) {
      const apiTeamId = Number(p.teamId);
      if (Number.isNaN(apiTeamId)) continue;
      const list = apiPlayersByTeamId.get(apiTeamId);
      if (list) list.push(p); else apiPlayersByTeamId.set(apiTeamId, [p]);
    }

    // Fed below with only players that ALREADY have a known identity this
    // tick (matchPlayer from a prior tick, or grpPlayer from the admin
    // roster) — kept deliberately conservative, unlike live-display
    // routing above. This permanent, cross-tournament roster was
    // specifically hardened once against blindly trusting
    // apiTeamId === slot: an unrelated squad's ephemeral teamId colliding
    // with a team's slot number used to permanently corrupt the wrong
    // team's roster. A bare teamId/slot match on a never-before-seen uid
    // is not reliable enough grounds for a PERMANENT roster write.
    const resolvedPlayersByTeamId = new Map(); // teamDbId(string) -> apiPlayer[]

    for (const team of matchData.teams) {
      const newTeamPlayers = [];
      const usedUIds = new Set();

      const groupPlayers = teamGroupPlayers.get(String(team.teamId)) || [];
      const teamApiPlayers = apiPlayersByTeamId.get(Number(team.slot)) || [];
      const matchDataByUid = new Map((team.players || []).map(p => [normalizeId(p.uId), p]));

      for (const apiPlayer of teamApiPlayers) {
        if (newTeamPlayers.length >= 4) break;
        const uid = normalizeId(apiPlayer.uId);
        if (usedUIds.has(uid)) continue;

        const matchPlayer = matchDataByUid.get(uid);
        let grpPlayer = groupPlayers.find(p => normalizeId(p.playerId) === uid);

        // Fallback for a roster player whose playerId is missing/mistyped:
        // try matching by playerName (trimmed, case-insensitive) within
        // THIS team's own roster only — groupPlayers is already scoped to
        // `team`, so no cross-team risk. Rescues already-existing rosters
        // with bad playerId data (new writes are now validated at the
        // source — see teams.controller.js's validatePlayerIds) without
        // needing a manual re-entry, and is what lets the roster photo
        // (grpPlayer.photo, below) still get attached.
        if (!matchPlayer && !grpPlayer && apiPlayer.playerName) {
          const apiNameNorm = String(apiPlayer.playerName).trim().toLowerCase();
          if (apiNameNorm) {
            grpPlayer = groupPlayers.find(
              p => p.playerName && String(p.playerName).trim().toLowerCase() === apiNameNorm
            );
          }
        }

        let finalPlayer;
        if (matchPlayer || grpPlayer) {
          finalPlayer = {
            ...apiPlayer,
            _id:                   new mongoose.Types.ObjectId(),
            uId:                   uid,
            playerOpenId:          matchPlayer?.playerOpenId  || grpPlayer?.playerOpenId  || apiPlayer.playerOpenId || '',
            playerName:            matchPlayer?.playerName?.trim() || grpPlayer?.playerName?.trim() || apiPlayer.playerName,
            picUrl:                matchPlayer?.picUrl?.trim() || grpPlayer?.photo?.trim() || apiPlayer.picUrl || '',
            showPicUrl:            '',
            teamIdfromApi:         team.slot,
            location:              apiPlayer.location || { x: 0, y: 0, z: 0 },
            bHasDied:              apiPlayer.liveState === 5,
            health:                nonNeg(apiPlayer.health),
            healthMax:             (typeof apiPlayer.healthMax === 'number' && apiPlayer.healthMax > 0) ? apiPlayer.healthMax : 100,
            liveState:             nonNeg(apiPlayer.liveState),
            rank:                  nonNeg(apiPlayer.rank),
            killNum:               nonNeg(apiPlayer.killNum),
            killNumBeforeDie:      nonNeg(apiPlayer.killNumBeforeDie),
            damage:                nonNeg(apiPlayer.damage),
            assists:               nonNeg(apiPlayer.assists),
            knockouts:             nonNeg(apiPlayer.knockouts),
            headShotNum:           nonNeg(apiPlayer.headShotNum),
            survivalTime:          nonNeg(apiPlayer.survivalTime),
            isFiring:              apiPlayer.isFiring             || false,
            isOutsideBlueCircle:   apiPlayer.isOutsideBlueCircle || false,
            inDamage:              nonNeg(apiPlayer.inDamage),
            driveDistance:         nonNeg(apiPlayer.driveDistance),
            marchDistance:         nonNeg(apiPlayer.marchDistance),
            outsideBlueCircleTime: nonNeg(apiPlayer.outsideBlueCircleTime),
            rescueTimes:           nonNeg(apiPlayer.rescueTimes),
            gotAirDropNum:         nonNeg(apiPlayer.gotAirDropNum),
            maxKillDistance:       nonNeg(apiPlayer.maxKillDistance),
            killNumInVehicle:      nonNeg(apiPlayer.killNumInVehicle),
            killNumByGrenade:      nonNeg(apiPlayer.killNumByGrenade),
            AIKillNum:             nonNeg(apiPlayer.AIKillNum),
            BossKillNum:           nonNeg(apiPlayer.BossKillNum),
            useSmokeGrenadeNum:    nonNeg(apiPlayer.useSmokeGrenadeNum),
            useFragGrenadeNum:     nonNeg(apiPlayer.useFragGrenadeNum),
            useBurnGrenadeNum:     nonNeg(apiPlayer.useBurnGrenadeNum),
            useFlashGrenadeNum:    nonNeg(apiPlayer.useFlashGrenadeNum),
            PoisonTotalDamage:     nonNeg(apiPlayer.PoisonTotalDamage),
            UseSelfRescueTime:     nonNeg(apiPlayer.UseSelfRescueTime),
            UseEmergencyCallTime:  nonNeg(apiPlayer.UseEmergencyCallTime),
            heal:                  nonNeg(apiPlayer.heal),
            teamId:                apiPlayer.teamId,
            teamName:              apiPlayer.teamName             || '',
            character:             apiPlayer.character            || 'None',
            playerKey:             apiPlayer.playerKey            || 0,
          };

          const teamDbId = String(team.teamId);
          const list = resolvedPlayersByTeamId.get(teamDbId);
          if (list) list.push(apiPlayer); else resolvedPlayersByTeamId.set(teamDbId, [apiPlayer]);
        } else {
          finalPlayer = {
            ...apiPlayer,
            _id:           new mongoose.Types.ObjectId(),
            uId:           uid,
            teamIdfromApi: team.slot,
            location:      apiPlayer.location || { x: 0, y: 0, z: 0 },
            bHasDied:      apiPlayer.liveState === 5,
            picUrl:        apiPlayer.picUrl || '',
            showPicUrl:    '',
            playerName:    apiPlayer.playerName,
            // `...apiPlayer` above spreads every raw field unguarded — same
            // -1-sentinel leak as the branch above, so re-clamp the numeric
            // stats explicitly rather than trusting the spread.
            health:        nonNeg(apiPlayer.health),
            liveState:     nonNeg(apiPlayer.liveState),
            killNum:       nonNeg(apiPlayer.killNum),
            damage:        nonNeg(apiPlayer.damage),
            rank:          nonNeg(apiPlayer.rank),
          };
        }

        newTeamPlayers.push(finalPlayer);
        usedUIds.add(uid);
      }

      const teamRank = newTeamPlayers.length
        ? Math.min(...newTeamPlayers.map(p => p.rank || 0))
        : 0;

      // A manual correction via updateTeamPoints locks placePoints/rank —
      // leave them alone until an operator explicitly unlocks, instead of
      // silently reverting the correction on this tick.
      if (!team.placePointsLocked) {
        team.rank = teamRank;
        team.placePoints = ((rank) => {
          switch (rank) {
            case 1: return 10;
            case 2: return 6;
            case 3: return 5;
            case 4: return 4;
            case 5: return 3;
            case 6: return 2;
            case 7: return 1;
            case 8: return 1;
            default: return 0;
          }
        })(teamRank);
      }

      // team.players reflects only players actually reported live by the
      // API this tick — no backfilling from the registered roster. A team
      // with fewer live players than its roster size simply has fewer
      // entries here; see isTeamAllDead (Bulkpublic.controller.js) and its
      // frontend mirror (PublicThemeRenderer.tsx) for how elimination is
      // detected without assuming a fixed 4-player array.
      team.players = newTeamPlayers;
    }

    updateTeamsWithApiPlayers(resolvedPlayersByTeamId, matchId, userId).catch(err =>
      console.error(`[updateTeamsWithApiPlayers] user ${userId} match ${matchId}:`, err.message)
    );

    const updatedObject = matchData;
    const cacheKey = `${String(userId)}:${String(matchId)}`;

    // Skip the DB write (and cache overwrite) entirely if nothing tracked
    // actually changed since last tick — most ticks for most matches are
    // no-ops, so this is the biggest lever once many matches run at once.
    const newFingerprint = computeFingerprintParts(updatedObject);
    const prevFingerprint = lastFingerprintByUserMatch[cacheKey];
    const unchanged = fingerprintsEqual(newFingerprint, prevFingerprint);

    if (unchanged) {
      return { data: updatedObject, changed: false };
    }

    liveMatchCache.set(cacheKey, updatedObject);
    lastFingerprintByUserMatch[cacheKey] = newFingerprint;

    saveQueue.push({
      matchId,
      userId,
      teams: updatedObject.teams,
    });
    processSaveQueue();

    if (VERBOSE_MATCH_LOGS) {
      console.log(
        `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
        `${c('green', '✔ DB update queued')} for match=${matchId} user=${String(userId)}`
      );
    }

    return { data: updatedObject, changed: true };
  };

  // ─── Per-User Update Pass ───────────────────────────────────────────────────
  const pollForUser = async (userKey) => {
    if (!userKey) return false;

    let hadChanges = false;
    const dbUserId =
      userKeyToDbId.get(String(userKey)) ||
      (mongoose.Types.ObjectId.isValid(String(userKey))
        ? new mongoose.Types.ObjectId(String(userKey))
        : userKey);

    try {
      const roundIds = await getApiEnabledRoundIds();
      if (!roundIds.length) return false;

      const selectedMatches = await MatchSelection.find({
        isSelected: true,
        userId:     dbUserId,
        roundId:    { $in: roundIds }
      }).lean();

      if (!selectedMatches.length) return false;

      const liveEntry = liveApiPlayersByUser.get(String(userKey));
      const apiPlayers = liveEntry?.players || [];
      const apiPlayersAt = liveEntry?.at || null;

      // Independent matches for the same user can update in parallel too
      await Promise.all(selectedMatches.map(async (selected) => {
        const selUserId = selected.userId;

        if (!selected.isPollingActive) return;

        const result = await updateMatchDataWithLiveStats(selected.matchId, selUserId, apiPlayers, apiPlayersAt);
        if (!result) return;

        const { data: updatedMatchData, changed } = result;
        const cacheKey    = `${String(userKey)}:${String(selected.matchId)}`;
        const memoryMatch = liveMatchCache.get(cacheKey) || updatedMatchData;
        const lastData    = lastMatchDataByUserMatch[cacheKey];

        // ─────────────────────────────────────────────────────────────────
        // Frontend forwarding. liveMatchUpdate/overallDataUpdate go to two
        // destinations:
        //   1. `user:${userKey}` — the authenticated dashboard
        //      (matchDataController.tsx), plain JSON, unchanged.
        //   2. `round:${tournamentId}:${roundId}` — the public overlay
        //      (PublicThemeRenderer.tsx), msgpack-encoded binary, no login
        //      required. Always the FULL match/standings object, never a
        //      diff — a missed tick just gets caught up by the next one.
        //
        // computeOverallMatchDataForRound (round-wide standings) is fired
        // WITHOUT being awaited — it scans every MatchData in the round and
        // re-aggregates every player, easily the most expensive step here,
        // and this function's caller (pollForUser) is what `userProcessing`
        // gates tick-acceptance on. Awaiting it here used to mean a slow
        // round (many matches) could make a single tick's processing take
        // longer than the ~2s gap between PCOB ticks, silently dropping the
        // next tick for this user since userProcessing was still held.
        // overallRecomputeInFlight prevents two recomputes for the same
        // match stacking if a tick arrives while the previous one is still
        // running — it just skips that tick's recompute rather than queuing
        // or blocking; the next changed tick will try again.
        // ─────────────────────────────────────────────────────────────────
        const emitOverallUpdate = async () => {
          if (overallRecomputeInFlight.has(cacheKey)) return;
          overallRecomputeInFlight.add(cacheKey);
          try {
            const overallTeams = await computeOverallMatchDataForRound(
              selected.tournamentId, selected.roundId, selected.matchId, selUserId
            );
            const overallFingerprint = computeOverallFingerprintParts(overallTeams);
            const unchangedOverall = fingerprintsEqual(overallFingerprint, lastOverallFingerprintByUserMatch[cacheKey]);
            lastOverallFingerprintByUserMatch[cacheKey] = overallFingerprint;
            if (!unchangedOverall) {
              const overallPayload = {
                tournamentId: selected.tournamentId,
                roundId:      selected.roundId,
                matchId:      selected.matchId,
                teams:        overallTeams,
                createdAt:    new Date()
              };
              // not volatile — overall standings should always land
              io.to(`user:${userKey}`).emit('overallDataUpdate', overallPayload);
              io.to(`round:${selected.tournamentId}:${selected.roundId}`).emit(
                'overallDataUpdate',
                encodeMsgpack(overallPayload)
              );
            }
          } catch (overallError) {
            console.warn('Failed to compute overall data:', overallError.message);
          } finally {
            overallRecomputeInFlight.delete(cacheKey);
          }
        };

        const emitUpdates = () => {
          memoryMatch.deadTeamList = updateDeadTeamList(selected.matchId, memoryMatch);

          // volatile: if a client's socket buffer is backed up, drop this
          // frame rather than queueing — always prefer the freshest data.
          io.to(`user:${userKey}`).volatile.emit('liveMatchUpdate', memoryMatch);

          // Public overlay: emit the full match object as soon as it's ready,
          // msgpack-encoded, in one frame.
          const roundRoom = `round:${selected.tournamentId}:${selected.roundId}`;
          io.to(roundRoom).volatile.emit(
            'liveMatchUpdate',
            encodeMsgpack({
              ...memoryMatch,
              matchId: String(selected.matchId),
            })
          );

          emitOverallUpdate().catch(err =>
            console.error(`[overall] ${cacheKey} error:`, err.message)
          );
        };

        if (!lastData) {
          if (VERBOSE_MATCH_LOGS) logFullMatchTable(memoryMatch);
          emitUpdates();
          lastMatchDataByUserMatch[cacheKey] = memoryMatch;
          hadChanges = true;
        } else if (changed) {
          if (VERBOSE_MATCH_LOGS) logMatchDiff(selected.matchId, lastData, memoryMatch);
          emitUpdates();
          lastMatchDataByUserMatch[cacheKey] = memoryMatch;
          hadChanges = true;
        } else if (VERBOSE_MATCH_LOGS) {
          console.log(
            `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
            `${c('yellow', '≈')} match=${selected.matchId} — no changes`
          );
        }
      }));
    } catch (err) {
      console.error(`[user ${userKey}] Update error:`, err);
    }

    return hadChanges;
  };

  // ─── User Discovery ─────────────────────────────────────────────────────────
  // This just maintains the set of users we should react for when a socket
  // push arrives — it no longer starts/stops any per-user polling timers.
  const discoverAndStartPollingUsers = async () => {
    try {
      const roundIds = await getApiEnabledRoundIds();
      if (!roundIds.length) {
        console.log('[discovery] No API-enabled rounds found');
        return;
      }

      const selectedMatches = await MatchSelection.find({
        isSelected:      true,
        userId:          { $exists: true, $ne: null },
        roundId:         { $in: roundIds },
        isPollingActive: true,
      }).lean();

      const activeUserIds = [];
      for (const s of selectedMatches) {
        const key = String(s.userId);
        userKeyToDbId.set(key, s.userId);
        activeUserIds.push(key);
      }

      const uniqueActiveUserIds = [...new Set(activeUserIds)];

      for (const uid of uniqueActiveUserIds) {
        if (!activeUserKeys.has(uid)) {
          activeUserKeys.add(uid);
          console.log(`[discovery] NOW ACTIVE (socket-driven) → ${uid}`);
        }
      }

      for (const existingUid of Array.from(activeUserKeys)) {
        if (!uniqueActiveUserIds.includes(existingUid)) {
          activeUserKeys.delete(existingUid);
          console.log(`[discovery] NO LONGER ACTIVE → ${existingUid}`);
        }
      }
    } catch (e) {
      console.error('[discovery] Error:', e);
    }
  };

  // ─── Background Save Interval (flush any leftover jobs) ──────────────────
  setInterval(() => {
    if (saveQueue.length > 0) {
      processSaveQueue();
    }
  }, 2000);

  // Boot: figure out who is active, then just wait for socket pushes.
  // Re-run discovery periodically ONLY to pick up new/removed selections —
  // this does not fetch or poll live player data, it just maintains the
  // active-user set used by triggerImmediateUpdateForUser().
  discoverAndStartPollingUsers();
  setInterval(discoverAndStartPollingUsers, 10000);
}

module.exports = { startLiveMatchUpdater };