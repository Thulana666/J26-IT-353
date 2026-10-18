// Authentication for sensor devices (ESP32 loggers and the simulator).
//
// Devices cannot hold a user session, so each one has its own key, sent as
//   X-Device-Id:  <device code>     e.g. ESP32-001
//   X-Device-Key: <device key>      shown once when the device is registered
// Only the SHA-256 hash of the key is stored. Keys are 256-bit random values,
// so a fast hash is sufficient (no password stretching needed). Never put the
// Supabase secret key on a device: a stolen device key only allows posting
// readings for that device's shipment, and an admin can rotate or deactivate it.

const crypto = require("node:crypto");
const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");

const KEY_PREFIX = "ccd_";

function generateDeviceKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

function hashDeviceKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

// Compared in constant time; an unknown device is checked against a dummy hash
// so the response time does not reveal which device codes exist.
const DUMMY_HASH = hashDeviceKey("no-such-device");

function keyMatches(storedHash, key) {
  const expected = Buffer.from(storedHash ?? DUMMY_HASH, "hex");
  const actual = Buffer.from(hashDeviceKey(key), "hex");
  const equal = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return equal && Boolean(storedHash);
}

const DEVICE_SELECT = "id, device_code, name, device_type, key_hash, is_active, last_seen_at";

async function authenticateDevice(req, _res, next) {
  const code = req.get("x-device-id")?.trim();
  const key = req.get("x-device-key")?.trim();
  if (!code || !key) throw new HttpError(401, "Missing device credentials (X-Device-Id and X-Device-Key headers)");
  if (code.length > 40 || key.length > 200) throw new HttpError(401, "Unknown device or wrong key");

  const device = unwrap(await supabase.from("cold_chain_devices").select(DEVICE_SELECT).eq("device_code", code).maybeSingle());
  if (!keyMatches(device?.key_hash, key)) throw new HttpError(401, "Unknown device or wrong key");
  if (!device.is_active) throw new HttpError(403, "This device is deactivated");

  const { key_hash: _hash, ...rest } = device;
  req.device = rest;
  next();
}

module.exports = { authenticateDevice, generateDeviceKey, hashDeviceKey };
