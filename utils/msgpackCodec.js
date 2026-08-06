const { encode } = require('@msgpack/msgpack');

// Mongoose .lean() docs contain ObjectId instances that msgpack's encoder
// can't walk directly (it encodes them as their raw {buffer:...} shape, not
// the hex string the frontend decoders expect). This used to be fixed by
// round-tripping the whole payload through JSON.stringify/JSON.parse first
// (which normalizes via ObjectId's own .toJSON() -> hex string) - but that
// pays THREE full walks of the object (stringify, parse, then msgpack's own
// encode) where one recursive pass suffices, and it runs synchronously on
// the hot per-tick emit path for every active match. This single-pass
// transform only converts what actually needs it: ObjectId -> hex string,
// and Date -> ISO string. Note @msgpack/msgpack DOES have native
// timestamp-extension support for real Date instances, but using it here
// would be a wire-format change from today (it decodes back to an actual
// Date object client-side, not the ISO string the old JSON.stringify path
// produced and the frontend decoders already expect) - converting
// explicitly keeps the output identical to before.
function isObjectId(value) {
  return typeof value === 'object' && value !== null && value._bsontype === 'ObjectId';
}

function normalizeForMsgpack(value) {
  if (isObjectId(value)) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForMsgpack);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = normalizeForMsgpack(value[key]);
    }
    return out;
  }
  return value;
}

function encodeMsgpack(data) {
  const normalized = normalizeForMsgpack(data);
  // ignoreUndefined matches the old JSON.stringify behavior, which silently
  // dropped undefined-valued keys entirely rather than encoding them as nil
  // - keeps the wire shape identical to what frontend decoders already
  // expect (an absent key, not a key with a null-ish value).
  return Buffer.from(encode(normalized, { ignoreUndefined: true }));
}

module.exports = { encodeMsgpack };
