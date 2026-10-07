const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyExpiry, assertThresholds, widestThresholds, DEFAULT_THRESHOLDS } = require("../../src/warehouse/expiry");
const { todayISO, daysBetween, isISODate, addDays } = require("../../src/warehouse/dates");

const TODAY = "2026-10-07";
const T = { nearExpiryDays: 90, criticalExpiryDays: 30 };

test("expiry date before today is expired", () => {
  assert.deepEqual(classifyExpiry("2026-10-06", TODAY, T), { status: "expired", daysToExpiry: -1 });
});

test("expiry date today is still usable but critical", () => {
  assert.deepEqual(classifyExpiry(TODAY, TODAY, T), { status: "critical", daysToExpiry: 0 });
});

test("critical and near-expiry boundaries are inclusive", () => {
  assert.equal(classifyExpiry(addDays(TODAY, 30), TODAY, T).status, "critical");
  assert.equal(classifyExpiry(addDays(TODAY, 31), TODAY, T).status, "near_expiry");
  assert.equal(classifyExpiry(addDays(TODAY, 90), TODAY, T).status, "near_expiry");
  assert.equal(classifyExpiry(addDays(TODAY, 91), TODAY, T).status, "ok");
});

test("custom thresholds change the classification", () => {
  const strict = { nearExpiryDays: 180, criticalExpiryDays: 60 };
  assert.equal(classifyExpiry(addDays(TODAY, 45), TODAY, strict).status, "critical");
  assert.equal(classifyExpiry(addDays(TODAY, 120), TODAY, strict).status, "near_expiry");
  assert.equal(classifyExpiry(addDays(TODAY, 45), TODAY).status, "near_expiry"); // defaults 90/30
});

test("thresholds must be positive with near > critical", () => {
  assert.deepEqual(assertThresholds({ nearExpiryDays: 60, criticalExpiryDays: 14 }), { nearExpiryDays: 60, criticalExpiryDays: 14 });
  assert.throws(() => assertThresholds({ nearExpiryDays: 30, criticalExpiryDays: 30 }), RangeError);
  assert.throws(() => assertThresholds({ nearExpiryDays: 30, criticalExpiryDays: 0 }), RangeError);
  assert.throws(() => assertThresholds({ nearExpiryDays: 30.5, criticalExpiryDays: 10 }), RangeError);
});

test("widest thresholds are used for a batch held in several warehouses", () => {
  assert.deepEqual(
    widestThresholds([{ nearExpiryDays: 90, criticalExpiryDays: 30 }, { nearExpiryDays: 120, criticalExpiryDays: 14 }]),
    { nearExpiryDays: 120, criticalExpiryDays: 30 }
  );
  assert.deepEqual(widestThresholds([]), DEFAULT_THRESHOLDS);
});

test("today is computed in the warehouse time zone", () => {
  // 20:00 UTC on 6 Oct is already 01:30 on 7 Oct in Sri Lanka (UTC+5:30).
  const instant = new Date("2026-10-06T20:00:00Z");
  assert.equal(todayISO(instant, "Asia/Colombo"), "2026-10-07");
  assert.equal(todayISO(instant, "UTC"), "2026-10-06");
});

test("date helpers", () => {
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(daysBetween("2027-01-01", "2026-12-31"), -1);
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.ok(isISODate("2028-02-29"));
  assert.ok(!isISODate("2027-02-29"));
  assert.ok(!isISODate("2026-1-07"));
  assert.ok(!isISODate(20261007));
});
