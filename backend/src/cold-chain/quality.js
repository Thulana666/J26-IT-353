// Data-quality checks for incoming readings (pure functions).
//
// Bad data is never adjusted: impossible values are rejected (validation.js,
// timeWindowError), suspicious but possible ones are stored unchanged with a
// flag explaining the concern.
//   delayed_upload  received long after it was recorded (buffered during a connection gap)
//   gps_jump        the position moved implausibly fast since the previous fix
//   after_delivery  recorded after the pharmacy received the shipment

const { INGEST } = require("./constants");

// Why a reading's timestamp cannot belong to this shipment, or null.
function timeWindowError(recordedAtMs, monitor, now = Date.now()) {
  if (recordedAtMs < INGEST.earliestValid) {
    return "is before 2020: the device clock is not set (sync it with NTP or GPS time)";
  }
  if (recordedAtMs > now + INGEST.maxClockAheadMs) return "is in the future: check the device clock";
  if (recordedAtMs < Date.parse(monitor.started_at)) return "is before monitoring of this shipment started";
  if (monitor.ended_at && recordedAtMs > Date.parse(monitor.ended_at)) {
    return "is after monitoring of this shipment ended";
  }
  return null;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance between two { latitude, longitude } points.
function haversineKm(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hasFix = (reading) =>
  reading !== null && reading !== undefined && reading.latitude !== null && reading.latitude !== undefined;

// Flags for new readings sorted oldest first (recordedAt in epoch ms).
// previous: the stored reading just before the first new one, if any.
function qualityFlags(readings, { previous = null, intervalSeconds, receivedAtMs, deliveredAt = null }) {
  const delayedAfterMs = Math.max(INGEST.delayedUploadMs, 3 * intervalSeconds * 1000);
  const deliveredMs = deliveredAt ? Date.parse(deliveredAt) : null;
  let lastFix = hasFix(previous) ? previous : null;

  return readings.map((reading) => {
    const flags = [];
    if (receivedAtMs - reading.recordedAt > delayedAfterMs) flags.push("delayed_upload");
    if (hasFix(reading)) {
      if (lastFix) {
        const km = haversineKm(lastFix, reading);
        const hours = (reading.recordedAt - lastFix.recordedAt) / 3_600_000;
        if (km >= INGEST.minJumpDistanceKm && (hours <= 0 || km / hours > INGEST.maxPlausibleSpeedKmh)) {
          flags.push("gps_jump");
        }
      }
      lastFix = reading;
    }
    if (deliveredMs !== null && reading.recordedAt > deliveredMs) flags.push("after_delivery");
    return flags;
  });
}

module.exports = { timeWindowError, haversineKm, qualityFlags };
