// The service module creates a Supabase client on load; no request is made here.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FEATURES, featuresAt, seriesRows, fitRidge, evaluateHoldout, forecastRecursive } = require("../../src/pharmacy/analytics/linear-regression");
const { getProvider } = require("../../src/pharmacy/analytics/forecast-provider");
const { replenishmentReason } = require("../../src/pharmacy/analytics/service");
const { addDays } = require("../../src/pharmacy/dates");

// Deterministic pseudo-random numbers in [0, 1).
function rng(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Daily series starting on a Sunday: base demand with a weekly pattern and noise.
function series(length, { base = 20, weekly = [0.5, 1.2, 1.1, 1, 1, 1.3, 0.9], noise = 0.2, seed = 1, closing = () => 100 } = {}) {
  const random = rng(seed);
  return Array.from({ length }, (_, i) => ({
    date: addDays("2026-01-04", i), // a Sunday
    sold: Math.round(base * weekly[i % 7] * (1 + noise * (random() - 0.5))),
    closingOnHand: closing(i),
  }));
}

test("least squares recovers known coefficients", () => {
  const random = rng(7);
  const rows = Array.from({ length: 200 }, () => {
    const x1 = random() * 10;
    const x2 = random() * 5;
    return { x: [1, x1, x2], y: 2 + 3 * x1 - x2 };
  });
  const [b0, b1, b2] = fitRidge(rows, 1e-9);
  assert.ok(Math.abs(b0 - 2) < 1e-6 && Math.abs(b1 - 3) < 1e-6 && Math.abs(b2 + 1) < 1e-6);
});

test("features for day t use only the days before t", () => {
  const days = series(60);
  const sold = days.map((d) => d.sold);
  const before = featuresAt(sold, 40, days[40].date);
  const changed = sold.map((v, i) => (i >= 40 ? v * 50 + 999 : v));
  assert.deepEqual(featuresAt(changed, 40, days[40].date), before);
  assert.equal(before.x.length, FEATURES.length);
  assert.equal(featuresAt(sold, 27, days[27].date), null, "needs 28 days of history");
});

test("days that ended out of stock are not training targets", () => {
  const days = series(60, { closing: (i) => (i === 45 ? 0 : 100) });
  const rows = seriesRows("a", days);
  assert.ok(!rows.some((r) => r.date === days[45].date));
  assert.ok(rows.some((r) => r.date === days[44].date));
});

test("the holdout is chronological and the baseline is the 28-day moving average", () => {
  const data = [
    { id: "a", days: series(150, { seed: 2 }) },
    { id: "b", days: series(150, { base: 6, seed: 3 }) },
  ];
  const result = evaluateHoldout(data, { testDays: 28 });
  assert.ok(result.train.to < result.test.from);
  assert.equal(result.test.to, data[0].days[149].date);
  for (const p of result.points) {
    const days = data.find((d) => d.id === p.id).days;
    const t = days.findIndex((d) => d.date === p.date);
    const ma = days.slice(t - 28, t).reduce((s, d) => s + d.sold, 0) / 28;
    assert.ok(Math.abs(p.baseline - ma) < 1e-9);
  }
  // A strong weekly pattern is what the day-of-week terms can learn.
  assert.ok(result.overall.linearRegression.mae < result.overall.movingAverage.mae);
});

test("too little history gives no evaluation instead of a misleading one", () => {
  assert.equal(evaluateHoldout([{ id: "a", days: series(40) }]), null);
});

test("recursive forecast is non-negative, covers the horizon and needs 28 stocked days", () => {
  const data = [{ id: "a", days: series(200) }];
  const { coefficients } = evaluateHoldout(data);
  const forecast = forecastRecursive(coefficients, data[0].days, 30);
  assert.equal(forecast.length, 30);
  assert.ok(forecast.every((v) => v >= 0 && Number.isFinite(v)));
  assert.equal(forecastRecursive(coefficients, data[0].days.slice(0, 20), 30), null);
  assert.equal(forecastRecursive([-100, 0, 0, 0, 0, 0, 0, 0, 0, 0], data[0].days, 5).every((v) => v === 0), true, "clipped at zero");
});

test("the provider uses the model only for products where it won, otherwise the moving average", () => {
  const days = series(200);
  const { coefficients } = evaluateHoldout([{ id: "a", days }]);
  const model = { method: "linear_regression", coefficients, perProduct: { a: { selected: true, residualSd: 2 }, b: { selected: false } } };
  const [a, b, c] = getProvider(model).forecast({ series: [{ id: "a", days }, { id: "b", days }, { id: "c", days }], horizonDays: 14, windowDays: 28 });
  assert.equal(a.model, "linear_regression");
  assert.equal(a.residualSd, 2);
  assert.equal(b.model, "moving_average");
  assert.equal(c.model, "moving_average");
  assert.equal(getProvider(null).engine, "moving_average");
  assert.equal(getProvider({ method: "linear_regression", coefficients: [NaN] }).engine, "moving_average");
});

test("the replenishment reason explains the recommendation", () => {
  const reorder = (over) => ({ dailyDemand: 8, inventoryPosition: 250, reorderPoint: 61, needsReorder: false, ...over });
  assert.match(replenishmentReason({ reorder: reorder(), cover: { status: "out_of_stock" } }, { incoming: 250, awaiting: 0 }, "strips"), /Out of stock now, but 250 strips on the way/);
  assert.match(replenishmentReason({ reorder: reorder({ inventoryPosition: 40, needsReorder: true }), cover: { status: "ok" } }, { incoming: 0, awaiting: 50 }, "strips"), /^Reorder: .*40 strips.*61.* 50 strips ordered are awaiting warehouse acceptance/);
  assert.match(replenishmentReason({ reorder: reorder({ dailyDemand: 0 }), cover: { status: "no_sales" } }, { incoming: 0, awaiting: 0 }, "units"), /No recent demand/);
});
