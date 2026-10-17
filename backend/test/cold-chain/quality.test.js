// Data-quality rules for incoming readings, and derived monitoring state.
const test = require("node:test");
const assert = require("node:assert/strict");
const { timeWindowError, haversineKm, qualityFlags } = require("../../src/cold-chain/quality");
const { defaultLimits, mergeLimits, connectionStatus, deliveryStatus } = require("../../src/cold-chain/monitoring");

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const COLOMBO = { latitude: 6.9271, longitude: 79.8612 };
const KANDY = { latitude: 7.2906, longitude: 80.6337 };

const monitor = { started_at: "2026-10-17T06:00:00Z", ended_at: null };

test("timestamps outside the monitoring window or from an unset clock are rejected", () => {
  assert.match(timeWindowError(Date.parse("1970-01-01T00:00:12Z"), monitor, NOW), /clock is not set/);
  assert.match(timeWindowError(Date.parse("2019-12-31T23:59:59Z"), monitor, NOW), /clock is not set/);
  assert.match(timeWindowError(NOW + 3 * MIN, monitor, NOW), /future/);
  assert.equal(timeWindowError(NOW + 1 * MIN, monitor, NOW), null, "small clock drift is tolerated");
  assert.match(timeWindowError(Date.parse("2026-10-17T05:59:59Z"), monitor, NOW), /before monitoring/);
  assert.equal(timeWindowError(Date.parse("2026-10-17T06:00:00Z"), monitor, NOW), null);

  const ended = { ...monitor, ended_at: "2026-10-17T10:00:00Z" };
  assert.match(timeWindowError(Date.parse("2026-10-17T10:00:01Z"), ended, NOW), /after monitoring/);
  assert.equal(timeWindowError(Date.parse("2026-10-17T09:59:00Z"), ended, NOW), null, "buffered readings from before the end are accepted");
});

test("haversine distance Colombo-Kandy is about 94 km", () => {
  const km = haversineKm(COLOMBO, KANDY);
  assert.ok(km > 90 && km < 98, `${km} km`);
  assert.equal(haversineKm(COLOMBO, COLOMBO), 0);
});

test("delayed uploads are flagged after 5 minutes, or 3 intervals for slow devices", () => {
  const readings = [{ recordedAt: NOW - 6 * MIN }, { recordedAt: NOW - 4 * MIN }];
  assert.deepEqual(qualityFlags(readings, { intervalSeconds: 60, receivedAtMs: NOW }), [["delayed_upload"], []]);
  // 5-minute interval: up to 15 minutes late is normal.
  assert.deepEqual(qualityFlags(readings, { intervalSeconds: 300, receivedAtMs: NOW }), [[], []]);
});

test("GPS jumps: implausible speed between fixes, also across requests; jitter and real driving are fine", () => {
  const at = (minutesAgo, pos) => ({ recordedAt: NOW - minutesAgo * MIN, ...pos });
  // Colombo -> Kandy (~94 km) in 2 minutes: a jump. Back to a nearby point at road speed: fine.
  const flags = qualityFlags([at(10, COLOMBO), at(8, KANDY), at(7, { latitude: 7.2956, longitude: 80.6337 })], {
    intervalSeconds: 60,
    receivedAtMs: NOW - 6 * MIN,
  });
  assert.deepEqual(flags, [[], ["gps_jump"], []]);

  // Previous stored fix in Colombo, new reading in Kandy one minute later.
  const previous = at(5, COLOMBO);
  assert.deepEqual(qualityFlags([at(4, KANDY)], { previous, intervalSeconds: 60, receivedAtMs: NOW - 4 * MIN }), [["gps_jump"]]);

  // 300 m of GPS jitter within 10 seconds is not a jump (below the 1 km floor).
  const jitter = [at(2, COLOMBO), { recordedAt: NOW - 2 * MIN + 10_000, latitude: 6.9298, longitude: 79.8612 }];
  assert.deepEqual(qualityFlags(jitter, { intervalSeconds: 60, receivedAtMs: NOW }), [[], []]);

  // Readings without a fix do not reset the last known position.
  const gap = [at(10, COLOMBO), { recordedAt: NOW - 9 * MIN, temperatureC: 5, latitude: null, longitude: null }, at(8, KANDY)];
  assert.deepEqual(qualityFlags(gap, { intervalSeconds: 60, receivedAtMs: NOW - 8 * MIN }), [[], [], ["gps_jump"]]);
});

test("readings recorded after the pharmacy received the shipment are flagged", () => {
  const flags = qualityFlags([{ recordedAt: NOW - 2 * MIN }, { recordedAt: NOW }], {
    intervalSeconds: 60,
    receivedAtMs: NOW,
    deliveredAt: new Date(NOW - MIN).toISOString(),
  });
  assert.deepEqual(flags, [[], ["after_delivery"]]);
});

test("default limits follow the strictest storage condition among the items", () => {
  assert.deepEqual(defaultLimits(["ambient", "refrigerated"]), {
    storageCondition: "refrigerated",
    mixed: true,
    tempMinC: 2,
    tempMaxC: 8,
    humidityMinPct: null,
    humidityMaxPct: 85,
  });
  assert.equal(defaultLimits(["frozen", "refrigerated"]).storageCondition, "frozen");
  assert.equal(defaultLimits(["cool", "cool"]).mixed, false);
  assert.equal(defaultLimits([null, undefined]).storageCondition, "ambient");
});

test("limit changes are merged and must keep a valid range; null clears a humidity limit", () => {
  const current = { storageCondition: "refrigerated", tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 };
  assert.deepEqual(mergeLimits(current, { tempMaxC: 7, humidityMaxPct: null }).limits, { ...current, tempMaxC: 7, humidityMaxPct: null });
  assert.deepEqual(mergeLimits(current, { tempMinC: 8 }).errors, { tempMaxC: "must be above the minimum temperature" });
  assert.deepEqual(mergeLimits(current, { humidityMinPct: 90 }).errors, { humidityMaxPct: "must be above the minimum humidity" });
});

test("connection status from the age of the newest reading, in reading intervals", () => {
  const status = (secondsAgo, extra = {}) =>
    connectionStatus({
      lastReadingAt: secondsAgo === null ? null : new Date(NOW - secondsAgo * 1000).toISOString(),
      intervalSeconds: 60,
      monitoringStatus: "active",
      now: NOW,
      ...extra,
    }).status;
  assert.equal(status(30), "online");
  assert.equal(status(180), "online");
  assert.equal(status(181), "delayed");
  assert.equal(status(600), "delayed");
  assert.equal(status(601), "offline");
  assert.equal(status(null), "no_data");
  assert.equal(status(30, { monitoringStatus: "ended" }), "ended");
  assert.equal(connectionStatus({ lastReadingAt: new Date(NOW - 90_000).toISOString(), intervalSeconds: 60, now: NOW }).secondsSinceLastReading, 90);
});

test("delivery status: overdue in transit, delay of a late delivery, no delay without an expected time", () => {
  const expectedDeliveryAt = "2026-10-17T10:00:00Z";
  const inTransit = deliveryStatus({ shipmentStatus: "in_transit", dispatchedAt: "2026-10-17T06:00:00Z", expectedDeliveryAt, receivedAt: null, now: NOW });
  assert.equal(inTransit.isOverdue, true);
  assert.equal(inTransit.delayMinutes, 120);

  const late = deliveryStatus({ shipmentStatus: "received", expectedDeliveryAt, receivedAt: "2026-10-17T10:45:00Z", now: NOW });
  assert.deepEqual([late.isDelivered, late.isOverdue, late.delayMinutes], [true, false, 45]);

  const early = deliveryStatus({ shipmentStatus: "received", expectedDeliveryAt, receivedAt: "2026-10-17T09:00:00Z", now: NOW });
  assert.equal(early.delayMinutes, 0);

  const unknown = deliveryStatus({ shipmentStatus: "in_transit", expectedDeliveryAt: null, receivedAt: null, now: NOW });
  assert.deepEqual([unknown.isOverdue, unknown.delayMinutes], [false, null]);
});
