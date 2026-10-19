// Temporary prototype risk predictor, predicted-risk alerts and the provider
// interface that the CNN-LSTM model will plug into.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { predictRisk, slopePerMinute, levelOf } = require("../../src/cold-chain/risk/prototype");
const { planPredictedAlerts } = require("../../src/cold-chain/risk/predicted-alerts");
const { getRiskProvider } = require("../../src/cold-chain/risk/provider");

const NOW = Date.parse("2026-10-18T06:00:00Z");
const MIN = 60_000;
const LIMITS = { tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 };
const COLOMBO = { latitude: 6.9271, longitude: 79.8612 };

// One reading a minute for `count` minutes up to NOW; fn(i) gives the fields.
function series(count, fn) {
  return Array.from({ length: count }, (_, i) => ({
    recordedAt: NOW - (count - 1 - i) * MIN,
    temperatureC: 5,
    humidityPct: 60,
    latitude: null,
    longitude: null,
    speedKmh: 40,
    qualityFlags: [],
    ...fn(i),
  }));
}
const trip = (overrides = {}) => ({ expectedDeliveryAt: null, startedAt: new Date(NOW - 120 * MIN).toISOString(), intervalSeconds: 60, ...overrides });
const predict = (readings, overrides = {}) => predictRisk({ readings, limits: LIMITS, trip: trip(), destination: null, now: NOW, ...overrides });

test("slope and risk levels", () => {
  assert.equal(Math.round(slopePerMinute([{ t: 0, v: 1 }, { t: MIN, v: 2 }, { t: 2 * MIN, v: 3 }]) * 1000) / 1000, 1);
  assert.deepEqual([levelOf(0.1), levelOf(0.3), levelOf(0.69), levelOf(0.7)], ["low", "medium", "medium", "high"]);
});

test("stable readings in range: low risk, no dominant type, explanation says so", () => {
  const result = predict(series(30, () => ({})));
  assert.equal(result.riskLevel, "low");
  assert.equal(result.riskType, null);
  assert.ok(result.riskProbability < 0.3);
  assert.match(result.explanation, /No significant/);
  assert.equal(result.readingsUsed, 30);
  assert.equal(result.dataUntil, new Date(NOW).toISOString());
});

test("a rising temperature trend predicts a potential excursion before it happens", () => {
  // 5.0 -> 7.2 °C over 23 min: about 0.1 °C/min, ~8 min from the 8 °C limit.
  const result = predict(series(23, (i) => ({ temperatureC: 5 + i * 0.1 })));
  const factor = result.factors.temperature_excursion;
  assert.ok(factor.probability > 0.8, `probability ${factor.probability}`);
  assert.match(factor.explanation, /rising about 0\.1 °C\/min and may cross the 8 °C limit in about \d+ min/);
  assert.equal(result.riskType, "temperature_excursion");
  assert.equal(result.riskLevel, "high");
});

test("a temperature already outside the range is near-certain risk, stated as a measurement", () => {
  const factor = predict(series(10, (i) => ({ temperatureC: i === 9 ? 9.2 : 5 }))).factors.temperature_excursion;
  assert.equal(factor.probability, 0.95);
  assert.match(factor.explanation, /outside the safe range now \(9\.2 °C, limit 8 °C\)/);
});

test("delivery delay: passed expected time, a slow remaining journey, an on-time journey", () => {
  const late = predict(series(10, () => ({})), { trip: trip({ expectedDeliveryAt: new Date(NOW - 20 * MIN).toISOString() }) });
  assert.equal(late.factors.delivery_delay.probability, 0.95);
  assert.match(late.factors.delivery_delay.explanation, /passed 20 min ago/);

  // ~30 km at 30 km/h takes ~60 min, but delivery is expected in 20 min.
  const destination = { latitude: COLOMBO.latitude + 0.27, longitude: COLOMBO.longitude };
  const moving = series(20, () => ({ ...COLOMBO, speedKmh: 30 }));
  const slow = predict(moving, { destination, trip: trip({ expectedDeliveryAt: new Date(NOW + 20 * MIN).toISOString() }) });
  assert.ok(slow.factors.delivery_delay.probability > 0.9);
  assert.match(slow.factors.delivery_delay.explanation, /About 30 km remain; at the recent average speed of 30 km\/h the estimated arrival is \d\d:\d\d, \d+ min after/);

  const onTime = predict(moving, { destination, trip: trip({ expectedDeliveryAt: new Date(NOW + 120 * MIN).toISOString() }) });
  assert.ok(onTime.factors.delivery_delay.probability < 0.1);
});

test("route risk: silent sensor, long stop, GPS jumps", () => {
  const silent = predict(series(10, () => ({})).map((r) => ({ ...r, recordedAt: r.recordedAt - 25 * MIN })));
  assert.ok(silent.factors.route_anomaly.probability > 0.8);
  assert.match(silent.factors.route_anomaly.explanation, /No reading for 25 min/);

  const stopped = predict(series(45, () => ({ speedKmh: 0 })));
  assert.match(stopped.factors.route_anomaly.explanation, /not moved for about 44 min/);

  const jumpy = predict(series(10, (i) => ({ qualityFlags: i === 5 ? ["gps_jump"] : [] })));
  assert.match(jumpy.factors.route_anomaly.explanation, /1 implausible GPS jump/);
});

test("two significant risks at once are reported as combined", () => {
  const result = predict(series(10, (i) => ({ temperatureC: i === 9 ? 9 : 5 })), {
    trip: trip({ expectedDeliveryAt: new Date(NOW - 10 * MIN).toISOString() }),
  });
  assert.equal(result.riskType, "combined");
  assert.match(result.explanation, /^Several risks at once:/);
  assert.ok(result.riskProbability > 0.99);
});

test("wording states potential risk and never claims the product is spoiled", () => {
  const results = [
    predict(series(23, (i) => ({ temperatureC: 5 + i * 0.1 }))),
    predict(series(10, () => ({})), { trip: trip({ expectedDeliveryAt: new Date(NOW - 5 * MIN).toISOString() }) }),
  ];
  for (const r of results) {
    const text = [r.explanation, ...Object.values(r.factors).map((f) => f.explanation)].join(" ");
    assert.doesNotMatch(text, /spoil|ruin|destroy|unsafe to use|damaged/i);
  }
});

test("the default provider is the prototype and labels every result as such", async () => {
  delete process.env.COLD_CHAIN_RISK_MODEL;
  const provider = getRiskProvider();
  const result = await provider.predict({ readings: series(5, () => ({})), limits: LIMITS, trip: trip(), destination: null, now: NOW });
  assert.deepEqual([result.modelName, result.modelVersion, result.isPrototype], ["prototype_rules", "0.1", true]);
  for (const setting of ["trained", "cnn_lstm"]) {
    process.env.COLD_CHAIN_RISK_MODEL = setting;
    assert.equal(getRiskProvider().modelName, "trained");
  }
  delete process.env.COLD_CHAIN_RISK_MODEL;
});

// --- Predicted alerts --------------------------------------------------------------

const prediction = (factors, extra = {}) => ({
  modelName: "prototype_rules",
  modelVersion: "0.1",
  isPrototype: true,
  horizonMinutes: 60,
  riskType: null,
  riskProbability: 0,
  explanation: "",
  factors: Object.fromEntries(Object.entries(factors).map(([k, p]) => [k, { probability: p, explanation: `${k} explanation.` }])),
  ...extra,
});
const openAlert = (riskType, overrides = {}) => ({
  id: `alert-${riskType}`,
  dedupe_key: `predicted:${riskType}`,
  risk_type: riskType,
  risk_level: "medium",
  status: "open",
  first_detected_at: new Date(NOW - 10 * MIN).toISOString(),
  occurrences: 2,
  ...overrides,
});
const plan = (p, openAlerts = [], observedOpen = {}) => planPredictedAlerts({ prediction: p, openAlerts, observedOpen, now: NOW });

test("a predicted alert opens at 60%, with the probability and the model in its message", () => {
  const { upserts, resolves } = plan(prediction({ delivery_delay: 0.65, route_anomaly: 0.5 }));
  assert.deepEqual(resolves, []);
  assert.equal(upserts.length, 1, "50% route risk opens nothing");
  const [alert] = upserts;
  assert.deepEqual([alert.dedupeKey, alert.riskType, alert.riskLevel, alert.riskProbability], ["predicted:delivery_delay", "delivery_delay", "medium", 0.65]);
  assert.equal(alert.title, "Possible delivery delay");
  assert.match(alert.message, /Predicted risk 65% \(prototype rule-based predictor\)\.$/);
});

test("a continuing predicted risk updates its alert; it resolves only below 40%", () => {
  const existing = openAlert("delivery_delay");
  const [update] = plan(prediction({ delivery_delay: 0.85 }), [existing]).upserts;
  assert.deepEqual([update.id, update.riskLevel, update.occurrences], [existing.id, "high", 3]);
  assert.equal(update.firstDetectedAt, existing.first_detected_at);
  assert.deepEqual(plan(prediction({ delivery_delay: 0.5 }), [existing]), { upserts: [], resolves: [] }, "50% keeps it open");
  assert.deepEqual(plan(prediction({ delivery_delay: 0.3 }), [existing]).resolves, [existing.id]);
});

test("predicted alerts only escalate; an escalated acknowledged alert is reopened", () => {
  const [kept] = plan(prediction({ route_anomaly: 0.65 }), [openAlert("route_anomaly", { risk_level: "high" })]).upserts;
  assert.equal(kept.riskLevel, "high");
  const [reopened] = plan(prediction({ route_anomaly: 0.9 }), [openAlert("route_anomaly", { status: "acknowledged" })]).upserts;
  assert.equal(reopened.reopen, true);
});

test("a measured excursion suppresses (and closes) the predicted one for the same measurement", () => {
  const p = prediction({ temperature_excursion: 0.95 });
  assert.deepEqual(plan(p, [], { temperature_excursion: true }).upserts, []);
  assert.deepEqual(plan(p, [openAlert("temperature_excursion")], { temperature_excursion: true }).resolves, ["alert-temperature_excursion"]);
});

test("combined risk has its own alert at 70%", () => {
  const p = prediction({ delivery_delay: 0.55, route_anomaly: 0.55 }, { riskType: "combined", riskProbability: 0.8, explanation: "Several risks at once." });
  const combined = plan(p).upserts.find((u) => u.riskType === "combined");
  assert.equal(combined.title, "Combined cold-chain risk");
  assert.equal(combined.riskLevel, "high");
  assert.deepEqual(plan(prediction({ delivery_delay: 0.2 }), [openAlert("combined")]).resolves, ["alert-combined"]);
});
