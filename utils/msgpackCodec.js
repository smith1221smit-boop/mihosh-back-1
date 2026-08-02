const { encode } = require('@msgpack/msgpack');

// Mongoose .lean() docs contain ObjectId/Date instances that msgpack's
// encoder can't walk directly. Round-tripping through JSON first normalizes
// them via their own .toJSON() (ObjectId -> hex string, Date -> ISO string),
// same as what res.json() does implicitly today, so the on-wire field shapes
// stay identical to the JSON payload this replaces.
function encodeMsgpack(data) {
  const normalized = JSON.parse(JSON.stringify(data));
  return Buffer.from(encode(normalized));
}

module.exports = { encodeMsgpack };
