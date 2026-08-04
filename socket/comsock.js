const { buildBulkPayload } = require('../controller/Bulkpublic.controller');
const { invalidateScope } = require('../middleware/cache.js');
const { encodeMsgpack } = require('../utils/msgpackCodec');
const Match = require('../models/match.model');
const MatchData = require('../models/matchData.model');
const MatchSelection = require('../models/MatchSelection.model');
const Round = require('../models/round.model');

const ROOM = (tournamentId, roundId) => `bulk:${tournamentId}:${roundId}`;

// Leading+trailing per round: a burst of writes to the same round (e.g. a
// matchdata doc updating many players in a short window) still collapses
// into one payload build + one emit via the trailing fire, but the FIRST
// write in an otherwise-isolated window (the common case) emits immediately
// instead of always waiting the full DEBOUNCE_MS with nothing to coalesce.
const pendingTimers = new Map(); // key -> { timer, pendingTrailing }
const DEBOUNCE_MS = 250;

// getMatchDataByMatchId/getBulkData/overall are cached (middleware/cache.js)
// under resource-based scopes rather than session scopes, precisely so this
// change-stream handler — which fires on every write regardless of whether
// it came from the live PUBG-API pipeline or a manual REST edit — can bust
// the exact affected cache entries immediately instead of waiting out the
// short TTL. Fire-and-forget: cache invalidation must never block/slow the
// live-data path.
function bustCache(matchId, tournamentId, roundId) {
  if (matchId) invalidateScope(`match:${matchId}`).catch(() => {});
  if (tournamentId && roundId) invalidateScope(`round:${tournamentId}:${roundId}`).catch(() => {});
}

function scheduleEmit(io, tournamentId, roundId, matchId, followSelected) {
  if (!tournamentId || !roundId) return;
  const key = `${tournamentId}:${roundId}`;

  const state = pendingTimers.get(key);
  if (state) {
    // Already in a cooldown window from an earlier write — remember to
    // fire once more when it closes, coalescing this burst into one
    // trailing emit exactly like before.
    state.pendingTrailing = { matchId, followSelected };
    return;
  }

  const emitNow = async (mId, fSel) => {
    try {
      const payload = await buildBulkPayload({
        tournamentId,
        roundId,
        matchId: mId,
        followSelected: fSel,
        // liveUpdate (not includeAll): sends the lightweight schedule/overall
        // data every mounted view needs, plus the one match that actually
        // changed — but skips re-embedding every match's full roster on
        // every tick, which is what includeAll used to force.
        liveUpdate: true,
      });
      io.to(ROOM(tournamentId, roundId)).emit('bulkUpdate', encodeMsgpack(payload));
    } catch (err) {
      console.error('bulkSocket: failed to build/emit payload', err);
    }
  };

  // Leading edge: fire immediately for the first write in this window.
  emitNow(matchId, followSelected);

  const timer = setTimeout(() => {
    const s = pendingTimers.get(key);
    pendingTimers.delete(key);
    if (s && s.pendingTrailing) {
      emitNow(s.pendingTrailing.matchId, s.pendingTrailing.followSelected);
    }
  }, DEBOUNCE_MS);

  pendingTimers.set(key, { timer, pendingTrailing: null });
}

/**
 * Wire up bulk-data rooms and MongoDB change streams.
 * Call this once, after `io` is created — e.g. in server.js:
 *
 *   const io = initializeSocket(server);
 *   require('./socket/bulkSocket').registerBulkSocket(io);
 *
 * Requires MongoDB change streams (needs a replica set — Atlas clusters,
 * including the mongodb+srv:// one already in use here, support this
 * out of the box).
 */
function registerBulkSocket(io) {
  io.on('connection', (socket) => {
    socket.on('joinBulkRoom', ({ tournamentId, roundId }) => {
      if (!tournamentId || !roundId) return;
      socket.join(ROOM(tournamentId, roundId));
    });

    socket.on('leaveBulkRoom', ({ tournamentId, roundId }) => {
      if (!tournamentId || !roundId) return;
      socket.leave(ROOM(tournamentId, roundId));
    });
  });

  // Any write to a match's live data -> refresh that match's round
  const matchDataStream = MatchData.watch([], { fullDocument: 'updateLookup' });
  matchDataStream.on('change', async (change) => {
    const doc = change.fullDocument;
    if (!doc) return;
    try {
      const match = await Match.findById(doc.matchId).lean();
      if (!match) return;
      bustCache(doc.matchId.toString(), match.tournamentId.toString(), match.roundId.toString());
      scheduleEmit(io, match.tournamentId.toString(), match.roundId.toString(), doc.matchId.toString(), false);
    } catch (err) {
      console.error('bulkSocket: matchData change handler error', err);
    }
  });
  matchDataStream.on('error', (err) => console.error('bulkSocket: matchData change stream error', err));

  // New match, matchNo changes, group reassignments, etc.
  const matchStream = Match.watch([], { fullDocument: 'updateLookup' });
  matchStream.on('change', (change) => {
    const doc = change.fullDocument;
    if (!doc) return;
    bustCache(doc._id.toString(), doc.tournamentId.toString(), doc.roundId.toString());
    // followSelected: true — a match being created/edited (matchNo, groups,
    // etc.) is not itself a statement about which match is "current".
    // Resolving effectiveMatchId via the real MatchSelection/latest-match
    // lookup (same as the explicit selection-change path below) stops this
    // event from hijacking currentMatchData with whichever match happened
    // to change, which isn't necessarily the one being displayed.
    scheduleEmit(io, doc.tournamentId.toString(), doc.roundId.toString(), null, true);
  });
  matchStream.on('error', (err) => console.error('bulkSocket: match change stream error', err));

  // Which match is "selected" changed -> refresh clients using followSelected
  const selectionStream = MatchSelection.watch([], { fullDocument: 'updateLookup' });
  selectionStream.on('change', (change) => {
    const doc = change.fullDocument;
    if (!doc) return;
    bustCache(doc.matchId?.toString(), doc.tournamentId.toString(), doc.roundId.toString());
    scheduleEmit(io, doc.tournamentId.toString(), doc.roundId.toString(), doc.matchId?.toString(), true);
  });
  selectionStream.on('error', (err) => console.error('bulkSocket: selection change stream error', err));

  // Round-level metadata changes
  const roundStream = Round.watch([], { fullDocument: 'updateLookup' });
  roundStream.on('change', (change) => {
    const doc = change.fullDocument;
    if (!doc) return;
    bustCache(null, doc.tournamentId.toString(), doc._id.toString());
    // followSelected: true — see matchStream comment above. Previously this
    // was followSelected:false with matchId:null, which resolved
    // effectiveMatchId to null and nulled out currentMatchData for every
    // connected client on any round-metadata edit.
    scheduleEmit(io, doc.tournamentId.toString(), doc._id.toString(), null, true);
  });
  roundStream.on('error', (err) => console.error('bulkSocket: round change stream error', err));

  console.log('✅ Bulk socket rooms + change streams registered');
}

module.exports = { registerBulkSocket, ROOM, scheduleEmit, bustCache };