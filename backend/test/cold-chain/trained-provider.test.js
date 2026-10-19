// The "trained" risk provider against a stub AI service: the request it sends,
// how a trained prediction is passed on, and the labelled prototype fallback.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const NOW = Date.parse("2026-10-18T06:00:00Z");
const MIN = 60_000;
const input = {
  readings: Array.from({ length: 150 }, (_, i) => ({
    recordedAt: NOW - (149 - i) * MIN,
    temperatureC: 5,
    humidityPct: 60,
    latitude: 6.9 + i * 0.001,
    longitude: 79.9,
    speedKmh: 40,
    qualityFlags: [],
  })),
  limits: { tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 },
  trip: { expectedDeliveryAt: new Date(NOW + 60 * MIN).toISOString(), startedAt: new Date(NOW - 150 * MIN).toISOString(), intervalSeconds: 60 },
  destination: { latitude: 7.29, longitude: 80.63 },
  origin: { latitude: 6.9, longitude: 79.9 },
  now: NOW,
};

const TRAINED = {
  riskLevel: "high",
  riskProbability: 0.82,
  riskType: "delivery_delay",
  temperatureRisk: 0.12,
  delayRisk: 0.82,
  explanation: "Overall HIGH risk (max of the estimated risks).",
  factors: { delivery_delay: { probability: 0.82, explanation: "Delivery: 82% estimated risk", details: {} } },
  components: { temperature: { available: true, probability: 0.12 }, delay: { available: true, probability: 0.82 } },
  combination: { method: "max" },
  cleaning: { input: 150, output: 150 },
  horizonMinutes: 30,
  readingsUsed: 150,
  dataUntil: new Date(NOW).toISOString(),
  modelName: "temperature:random_forest+delay:logistic_regression",
  modelVersion: "temperature:v1;delay:v1",
};

let reply = { status: 200, body: TRAINED };
let received = null;
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    received = { path: req.url, body: JSON.parse(data) };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
});

let trained;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  ({ trained } = require("../../src/cold-chain/risk/provider"));
});
test.after(() => server.close());

test("sends every reading since the trip start, the origin and the destination", async () => {
  reply = { status: 200, body: TRAINED };
  await trained.predict(input);
  assert.equal(received.path, "/cold-chain/predict");
  assert.equal(received.body.readings.length, 150);
  assert.equal(received.body.readings[0].recordedAt, new Date(NOW - 149 * MIN).toISOString());
  assert.deepEqual([received.body.origin, received.body.destination], [input.origin, input.destination]);
  assert.equal(received.body.now, new Date(NOW).toISOString());
});

test("a trained prediction is passed on with its risks and how it was formed", async () => {
  reply = { status: 200, body: TRAINED };
  const result = await trained.predict(input);
  assert.equal(result.isPrototype, false);
  assert.deepEqual([result.modelName, result.temperatureRisk, result.delayRisk, result.riskType], [TRAINED.modelName, 0.12, 0.82, "delivery_delay"]);
  assert.deepEqual(result.details, { components: TRAINED.components, combination: TRAINED.combination, cleaning: TRAINED.cleaning });
  assert.equal(result.components, undefined);
});

test("without a trained model (501) or enough data (422) the labelled prototype answers", async () => {
  for (const [status, reason] of [
    [501, "no_trained_model"],
    [422, "not_enough_data"],
  ]) {
    reply = { status, body: { detail: `stub ${status}` } };
    const result = await trained.predict(input);
    assert.deepEqual([result.isPrototype, result.modelName, result.modelVersion], [true, "prototype_rules", "0.1"]);
    assert.deepEqual(result.details.fallback, { reason, status, message: `stub ${status}` });
    assert.equal(result.temperatureRisk, undefined, "no trained-model risk is invented");
    assert.ok(result.factors.temperature_excursion, "the prototype's own factors");
  }
});

test("an unreachable or failing AI service also falls back to the labelled prototype", async (t) => {
  t.mock.method(console, "warn", () => {});
  reply = { status: 500, body: { detail: "boom" } };
  let result = await trained.predict(input);
  assert.deepEqual([result.isPrototype, result.details.fallback.reason, result.details.fallback.status], [true, "ai_service_error", 500]);

  const saved = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = "http://127.0.0.1:9";
  result = await trained.predict(input);
  process.env.AI_SERVICE_URL = saved;
  assert.deepEqual([result.isPrototype, result.details.fallback.reason], [true, "ai_service_unreachable"]);
  assert.equal(console.warn.mock.callCount(), 2);
});
