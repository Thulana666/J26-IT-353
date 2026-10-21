// Observed-condition alert rules: classification, one alert per condition,
// escalation, resolution and wording.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyTemperature, classifyHumidity, planObservedAlerts } = require("../../src/cold-chain/alert-rules");

const LIMITS = { tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 };
const BASE = Date.parse("2026-10-17T06:00:00Z");
const at = (minute) => new Date(BASE + minute * 60_000).toISOString();
const reading = (minute, temperatureC, humidityPct = 60) => ({ recordedAt: BASE + minute * 60_000, temperatureC, humidityPct });
const latestOf = (minute, temperatureC, humidityPct = 60) => ({ recordedAt: at(minute), temperatureC, humidityPct });

const openAlert = (overrides = {}) => ({
  id: "alert-1",
  dedupe_key: "temperature_excursion:above",
  risk_level: "high",
  basis: "observed",
  status: "open",
  first_detected_at: at(0),
  last_detected_at: at(2),
  occurrences: 3,
  details: { peakValue: 9.4, lastValue: 9.1 },
  ...overrides,
});

const plan = (readings, { latest = null, openAlerts = [], limits = LIMITS } = {}) =>
  planObservedAlerts({ readings, latest, openAlerts, limits });

test("temperature: inside the safe band, approaching a limit (medium), beyond it (high)", () => {
  assert.equal(classifyTemperature(5, LIMITS), null);
  assert.equal(classifyTemperature(7.5, LIMITS), null);
  assert.deepEqual(classifyTemperature(7.6, LIMITS), { side: "above", level: "medium", limit: 8 });
  assert.deepEqual(classifyTemperature(8, LIMITS), { side: "above", level: "medium", limit: 8 });
  assert.deepEqual(classifyTemperature(8.1, LIMITS), { side: "above", level: "high", limit: 8 });
  assert.deepEqual(classifyTemperature(2.3, LIMITS), { side: "below", level: "medium", limit: 2 });
  assert.deepEqual(classifyTemperature(1.9, LIMITS), { side: "below", level: "high", limit: 2 });
  assert.equal(classifyTemperature(null, LIMITS), null);
  // A 1 °C range: the warning band shrinks to a quarter of it (0.25 °C).
  const narrow = { tempMinC: 4, tempMaxC: 5 };
  assert.equal(classifyTemperature(4.7, narrow), null);
  assert.equal(classifyTemperature(4.8, narrow).level, "medium");
});

test("humidity: outside the configured range is medium; no limit means no alert", () => {
  assert.deepEqual(classifyHumidity(86, LIMITS), { side: "above", level: "medium", limit: 85 });
  assert.equal(classifyHumidity(10, LIMITS), null, "no lower limit configured");
  assert.deepEqual(classifyHumidity(10, { humidityMinPct: 20 }), { side: "below", level: "medium", limit: 20 });
  assert.equal(classifyHumidity(99, { humidityMinPct: null, humidityMaxPct: null }), null);
});

test("readings inside the limits plan nothing", () => {
  assert.deepEqual(plan([reading(0, 5), reading(1, 6)], { latest: latestOf(1, 6) }), { upserts: [], resolves: [] });
});

test("a batch with several breaches opens one alert per condition, with first/last time, peak and count", () => {
  const { upserts, resolves } = plan([reading(0, 8.5), reading(1, 9.4), reading(2, 9.1, 90)], { latest: latestOf(2, 9.1, 90) });
  assert.deepEqual(resolves, []);
  assert.equal(upserts.length, 2);
  const temp = upserts.find((u) => u.dedupeKey === "temperature_excursion:above");
  assert.equal(temp.id, null);
  assert.equal(temp.riskType, "temperature_excursion");
  assert.equal(temp.riskLevel, "high");
  assert.equal(temp.firstDetectedAt, at(0));
  assert.equal(temp.lastDetectedAt, at(2));
  assert.equal(temp.occurrences, 3);
  assert.deepEqual(temp.details, { measure: "temperatureC", side: "above", limit: 8, unit: "°C", peakValue: 9.4, lastValue: 9.1 });
  assert.equal(temp.resolve, false);
  const humidity = upserts.find((u) => u.dedupeKey === "humidity_deviation:above");
  assert.deepEqual([humidity.riskLevel, humidity.occurrences], ["medium", 1]);
});

test("a continuing excursion updates the open alert instead of adding a duplicate", () => {
  const existing = openAlert();
  const { upserts } = plan([reading(3, 8.8), reading(4, 9.0)], { latest: latestOf(4, 9.0), openAlerts: [existing] });
  assert.equal(upserts.length, 1);
  const [update] = upserts;
  assert.equal(update.id, "alert-1");
  assert.equal(update.occurrences, 5);
  assert.equal(update.firstDetectedAt, at(0));
  assert.equal(update.lastDetectedAt, at(4));
  assert.equal(update.details.peakValue, 9.4, "the earlier peak is kept");
  assert.equal(update.details.lastValue, 9.0);
});

test("alerts escalate but never de-escalate; an escalated acknowledged alert is opened again", () => {
  const approaching = openAlert({ risk_level: "medium", status: "acknowledged", details: { peakValue: 7.8 } });
  const [escalated] = plan([reading(3, 8.3)], { latest: latestOf(3, 8.3), openAlerts: [approaching] }).upserts;
  assert.equal(escalated.riskLevel, "high");
  assert.equal(escalated.reopen, true);
  assert.match(escalated.title, /above the safe range/);

  const [same] = plan([reading(3, 7.7)], { latest: latestOf(3, 7.7), openAlerts: [openAlert({ status: "acknowledged" })] }).upserts;
  assert.equal(same.riskLevel, "high", "a reading back in the warning band keeps the high level");
  assert.equal(same.reopen, false);
  assert.match(same.title, /above the safe range/);
});

test("an alert resolves when the newest reading is back inside the safe band", () => {
  const existing = openAlert();
  assert.deepEqual(plan([reading(3, 6)], { latest: latestOf(3, 6), openAlerts: [existing] }), { upserts: [], resolves: ["alert-1"] });
  // Still in the warning band on the same side: not over yet.
  assert.deepEqual(plan([reading(3, 7.8)], { latest: latestOf(3, 7.8), openAlerts: [existing] }).resolves, []);
  // The newest reading has no temperature (sensor fault): cannot tell, stays open.
  assert.deepEqual(plan([reading(3, null)], { latest: latestOf(3, null), openAlerts: [existing] }).resolves, []);
  // A late, older reading back in range does not resolve a newer detection.
  assert.deepEqual(plan([reading(1, 6)], { latest: latestOf(2, 9.1), openAlerts: [existing] }).resolves, []);
});

test("a buffered batch with a whole excursion records it and resolves it at once", () => {
  const [change] = plan([reading(0, 5), reading(1, 9.2), reading(2, 9.6), reading(3, 5.5)], { latest: latestOf(3, 5.5) }).upserts;
  assert.equal(change.id, null);
  assert.equal(change.riskLevel, "high");
  assert.equal(change.resolve, true);
  assert.equal(change.details.peakValue, 9.6);
  assert.deepEqual([change.firstDetectedAt, change.lastDetectedAt], [at(1), at(2)]);
});

test("below-range excursions keep the lowest value as the peak", () => {
  const [change] = plan([reading(0, 1.5), reading(1, 0.8), reading(2, 1.2)], { latest: latestOf(2, 1.2) }).upserts;
  assert.equal(change.dedupeKey, "temperature_excursion:below");
  assert.equal(change.details.peakValue, 0.8);
});

test("predicted alerts are left to the predictor", () => {
  const predicted = openAlert({ id: "p-1", basis: "predicted" });
  assert.deepEqual(plan([reading(3, 5)], { latest: latestOf(3, 5), openAlerts: [predicted] }).resolves, []);
});

test("wording reports measurements and limits and never claims the product is spoiled", () => {
  const { upserts } = plan([reading(0, 9.4), reading(1, 1.7, 92), reading(2, 7.9)], { latest: latestOf(2, 7.9) });
  assert.equal(upserts.length, 3);
  for (const { title, message } of upserts) {
    assert.doesNotMatch(`${title} ${message}`, /spoil|ruin|destroy|unsafe to use|damaged/i);
  }
  const high = upserts.find((u) => u.dedupeKey === "temperature_excursion:above");
  assert.match(high.message, /9\.4 °C, above the 8 °C limit/);
  assert.match(high.message, /Potential temperature excursion/);
  const humidity = upserts.find((u) => u.riskType === "humidity_deviation");
  assert.match(humidity.message, /92 % RH, above the configured 85 % RH/);
});
