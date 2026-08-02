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

// ─── In-Memory Live Match Cache ───────────────────────────────────────────────
const liveMatchCache = new Map();

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

// ─── Event Debounce / Concurrency Guards ──────────────────────────────────────
const EVENT_DEBOUNCE_MS = 150;   // coalesce bursts of rapid game-tick pushes per user

const debounceTimersByUser = new Map(); // userId -> Timeout
const userProcessing = new Set();       // prevents overlapping runs per user

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
  console.log(c('cyan', `[socket] relay registered → user ${key} (${socket.id})`));
});

    socket.on('totalPlayerList', (raw) => {
      const userId = socket.data.userId;
      if (!userId) {
        console.warn(c('yellow', `[socket] totalPlayerList from unregistered socket ${socket.id} — ignored`));
        return;
      }

      // Decode the MessagePack binary payload back into a plain object
      // before anything else touches it. Everything from here down is
      // IDENTICAL to before the wire-format change — `data` has exactly
      // the same shape (playerInfoList / isFull) it always did, it's
      // just arriving as decoded msgpack instead of JSON.
      let data;
      try {
        data = decodeTotalPlayerListPayload(raw);
      } catch (e) {
        console.error(c('red', `[socket] failed to decode msgpack totalPlayerList from ${socket.id} (user=${userId}): ${e.message}`));
        return;
      }

      // The relay now sends player-level deltas (isFull: false) once it has
      // a full picture — only players that actually changed this tick,
      // rather than the whole roster every time. Merge those into the
      // authoritative per-user snapshot instead of replacing it wholesale.
      // isFull true/absent (older relays that predate this change never
      // send the flag at all) falls back to the original replace behavior,
      // so an un-updated relay keeps working exactly as before.
      const incoming = data?.playerInfoList || data || [];
      const isDelta = data?.isFull === false;
      const existing = liveApiPlayersByUser.get(userId);

      let players;
      if (isDelta && existing?.players?.length) {
        const byKey = new Map(existing.players.map(p => [String(p.uId ?? p.playerName ?? ''), p]));
        for (const p of incoming) {
          byKey.set(String(p.uId ?? p.playerName ?? ''), p);
        }
        players = Array.from(byKey.values());
      } else {
        players = incoming;
      }

      liveApiPlayersByUser.set(userId, { players, at: Date.now() });

      console.log(
        `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
        `${c('cyan', '📡 received totalPlayerList')} ` +
        `(${c('bold', String(incoming.length))}${isDelta ? ' changed' : ''} of ${players.length} players) user=${userId} socket=${socket.id}`
      );

      // Debounce per user: bursts from ONE user's relay no longer delay or
      // trigger extra work for every other active user.
      if (debounceTimersByUser.has(userId)) {
        clearTimeout(debounceTimersByUser.get(userId));
      }
      const timer = setTimeout(() => {
        debounceTimersByUser.delete(userId);
        triggerImmediateUpdateForUser(userId).catch(err =>
          console.error(`[trigger] user ${userId} error:`, err)
        );
      }, EVENT_DEBOUNCE_MS);
      debounceTimersByUser.set(userId, timer);
    });

    socket.on('disconnect', () => {
      console.log(c('dim', `[socket] client disconnected: ${socket.id}`));
      const userId = socketIdToUserId.get(socket.id);
      socketIdToUserId.delete(socket.id);
      if (!userId) return;

      // Only clear this user's live-data state if no other socket (e.g. a
      // reconnect already in flight, or a second device) still claims them.
      const stillConnected = [...io.sockets.sockets.values()]
        .some(s => s.id !== socket.id && s.data?.userId === userId);

      if (!stillConnected) {
        liveApiPlayersByUser.delete(userId);
        if (debounceTimersByUser.has(userId)) {
          clearTimeout(debounceTimersByUser.get(userId));
          debounceTimersByUser.delete(userId);
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

  // ── Fired on every debounced socket push, scoped to ONE user ────────────
  async function triggerImmediateUpdateForUser(userId) {
    if (!activeUserKeys.has(userId)) return; // not an active/polling user — ignore
    if (userProcessing.has(userId)) return;  // already mid-flight, skip
    userProcessing.add(userId);
    try {
      await pollForUser(userId);
    } finally {
      userProcessing.delete(userId);
    }
  }

  // ─── Core Match Update ──────────────────────────────────────────────────────
  const updateMatchDataWithLiveStats = async (matchId, userId, apiPlayers, apiPlayersAt) => {
    // These two queries don't depend on each other — run in parallel.
    // .lean() on the selection query since we only read from it here.
    const [matchData, selectedMatch] = await Promise.all([
      MatchData.findOne({ matchId, userId }),
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

    const group = await Group.findOne({ tournamentId, userId }).populate('slots.team').lean();
    if (!group) {
      console.log('No group found for tournament:', tournamentId.toString());
      return null;
    }

    if (!apiPlayers?.length) {
      console.warn(`⚠️  No live player data received via socket yet for user=${userId} — skipping this cycle`);
      return matchData.toObject();
    }

    const STALE_MS = 15000;
    if (apiPlayersAt && Date.now() - apiPlayersAt > STALE_MS) {
      console.warn(
        `⚠️  Player data is stale (${Math.round((Date.now() - apiPlayersAt) / 1000)}s old) for user=${userId} — relay may be disconnected`
      );
    }

    await updateTeamsWithApiPlayers(apiPlayers, matchId, userId);

    const normalizeId = id => (id ? String(id).trim() : '');

    for (const team of matchData.teams) {
      const newTeamPlayers = [];
      const usedUIds = new Set();

      const groupSlot      = group.slots.find(s => s.team?._id.toString() === team.teamId.toString());
      const groupPlayers   = groupSlot?.team?.players || [];
      const teamApiPlayers = apiPlayers.filter(p => Number(p.teamId) === Number(team.slot));
      const matchDataByUid = new Map((team.players || []).map(p => [normalizeId(p.uId), p]));

      for (const apiPlayer of teamApiPlayers) {
        if (newTeamPlayers.length >= 4) break;
        const uid = normalizeId(apiPlayer.uId);
        if (usedUIds.has(uid)) continue;

        const matchPlayer = matchDataByUid.get(uid);
        const grpPlayer   = groupPlayers.find(p => normalizeId(p.playerId) === uid);

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
            health:                apiPlayer.health               || 0,
            healthMax:             apiPlayer.healthMax            || 100,
            liveState:             apiPlayer.liveState            || 0,
            killNum:               apiPlayer.killNum              || 0,
            killNumBeforeDie:      apiPlayer.killNumBeforeDie     || 0,
            damage:                apiPlayer.damage               || 0,
            assists:               apiPlayer.assists              || 0,
            knockouts:             apiPlayer.knockouts            || 0,
            headShotNum:           apiPlayer.headShotNum          || 0,
            survivalTime:          apiPlayer.survivalTime         || 0,
            isFiring:              apiPlayer.isFiring             || false,
            isOutsideBlueCircle:   apiPlayer.isOutsideBlueCircle || false,
            inDamage:              apiPlayer.inDamage             || 0,
            driveDistance:         apiPlayer.driveDistance        || 0,
            marchDistance:         apiPlayer.marchDistance        || 0,
            outsideBlueCircleTime: apiPlayer.outsideBlueCircleTime|| 0,
            rescueTimes:           apiPlayer.rescueTimes          || 0,
            gotAirDropNum:         apiPlayer.gotAirDropNum        || 0,
            maxKillDistance:       apiPlayer.maxKillDistance      || 0,
            killNumInVehicle:      apiPlayer.killNumInVehicle     || 0,
            killNumByGrenade:      apiPlayer.killNumByGrenade     || 0,
            AIKillNum:             apiPlayer.AIKillNum            || 0,
            BossKillNum:           apiPlayer.BossKillNum          || 0,
            useSmokeGrenadeNum:    apiPlayer.useSmokeGrenadeNum   || 0,
            useFragGrenadeNum:     apiPlayer.useFragGrenadeNum    || 0,
            useBurnGrenadeNum:     apiPlayer.useBurnGrenadeNum    || 0,
            useFlashGrenadeNum:    apiPlayer.useFlashGrenadeNum   || 0,
            PoisonTotalDamage:     apiPlayer.PoisonTotalDamage    || 0,
            UseSelfRescueTime:     apiPlayer.UseSelfRescueTime    || 0,
            UseEmergencyCallTime:  apiPlayer.UseEmergencyCallTime || 0,
            heal:                  apiPlayer.heal                 || 0,
            teamId:                apiPlayer.teamId,
            teamName:              apiPlayer.teamName             || '',
            character:             apiPlayer.character            || 'None',
            playerKey:             apiPlayer.playerKey            || 0,
          };
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
          };
        }

        newTeamPlayers.push(finalPlayer);
        usedUIds.add(uid);
      }

      const teamRank = newTeamPlayers.length
        ? Math.min(...newTeamPlayers.map(p => p.rank || 0))
        : 0;

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

      team.players = newTeamPlayers;
    }

    const updatedObject = matchData.toObject();
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

    console.log(
      `${c('dim', `[${new Date().toLocaleTimeString()}]`)} ` +
      `${c('green', '✔ DB update queued')} for match=${matchId} user=${String(userId)}`
    );

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
      const apiEnabledRounds = await Round.find({ apiEnable: true }).lean();
      if (!apiEnabledRounds.length) return false;

      const roundIds = apiEnabledRounds.map(r => r._id.toString());
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
        // Frontend forwarding — UNCHANGED. liveMatchUpdate/overallDataUpdate
        // are still emitted as normal Socket.IO JSON events to the browser
        // clients in this user's room. Only the relay→Node leg above was
        // converted to msgpack; this leg keeps whatever format the frontend
        // already expects.
        // ─────────────────────────────────────────────────────────────────
        const emitUpdates = async () => {
          // volatile: if a client's socket buffer is backed up, drop this
          // frame rather than queueing — always prefer the freshest data.
          // Scoped to this user's room only — other users no longer see it.
          io.to(`user:${userKey}`).volatile.emit('liveMatchUpdate', memoryMatch);
          try {
            const overallTeams = await computeOverallMatchDataForRound(
              selected.tournamentId, selected.roundId, selected.matchId, selUserId
            );
            const overallFingerprint = computeOverallFingerprintParts(overallTeams);
            const unchangedOverall = fingerprintsEqual(overallFingerprint, lastOverallFingerprintByUserMatch[cacheKey]);
            lastOverallFingerprintByUserMatch[cacheKey] = overallFingerprint;
            if (!unchangedOverall) {
              // not volatile — overall standings should always land
              io.to(`user:${userKey}`).emit('overallDataUpdate', {
                tournamentId: selected.tournamentId,
                roundId:      selected.roundId,
                matchId:      selected.matchId,
                teams:        overallTeams,
                createdAt:    new Date()
              });
            }
          } catch (overallError) {
            console.warn('Failed to compute overall data:', overallError.message);
          }
        };

        if (!lastData) {
          logFullMatchTable(memoryMatch);
          await emitUpdates();
          lastMatchDataByUserMatch[cacheKey] = memoryMatch;
          hadChanges = true;
        } else if (changed) {
          logMatchDiff(selected.matchId, lastData, memoryMatch);
          await emitUpdates();
          lastMatchDataByUserMatch[cacheKey] = memoryMatch;
          hadChanges = true;
        } else {
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
      const apiEnabledRounds = await Round.find({ apiEnable: true }).lean();
      if (!apiEnabledRounds.length) {
        console.log('[discovery] No API-enabled rounds found');
        return;
      }

      const roundIds = apiEnabledRounds.map(r => r._id.toString());
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