// The service module creates a Supabase client on load; no request is made here.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { alignForecast, getProvider, linearRegression, MAX_FORECAST_AGE_DAYS } = require("../../src/pharmacy/analytics/forecast-provider");
const { replenishmentReason } = require("../../src/pharmacy/analytics/service");
const { addDays } = require("../../src/pharmacy/dates");

const TODAY = "2026-10-21";
// 60 days of steady sales up to yesterday.
const days = Array.from({ length: 60 }, (_, i) => ({ date: addDays(TODAY, i - 60), sold: 10, closingOnHand: 100 }));
const stored = (start, values) => ({ start, values });

test("a stored forecast starting today is used as it is", () => {
  const values = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.deepEqual(alignForecast(stored(TODAY, values), 30, TODAY), values);
});

test("days already past are dropped and the end is filled with the average of what remains", () => {
  const values = Array.from({ length: 30 }, (_, i) => i + 1);
  const aligned = alignForecast(stored(addDays(TODAY, -2), values), 30, TODAY);
  assert.equal(aligned.length, 30);
  assert.deepEqual(aligned.slice(0, 3), [3, 4, 5]);
  const remainingMean = values.slice(2).reduce((t, v) => t + v, 0) / 28;
  assert.equal(aligned[29], remainingMean);
});

test("a forecast older than the limit, or a missing one, is not used", () => {
  assert.equal(alignForecast(stored(addDays(TODAY, -(MAX_FORECAST_AGE_DAYS + 1)), Array(30).fill(5)), 30, TODAY), null);
  assert.equal(alignForecast(null, 30, TODAY), null);
  assert.equal(alignForecast({ start: TODAY }, 30, TODAY), null);
});

test("products use the model's forecast only where it won; the rest use the moving average", () => {
  const model = {
    method: "linear_regression",
    perProduct: { a: { selected: true, residualSd: 2 }, b: { selected: false }, c: { selected: true } },
    forecasts: { a: stored(TODAY, Array(30).fill(7)), b: stored(TODAY, Array(30).fill(99)), c: null },
  };
  const series = ["a", "b", "c", "d"].map((id) => ({ id, days }));
  const [a, b, c, d] = linearRegression(model, TODAY).forecast({ series, horizonDays: 30, windowDays: 28 });
  assert.equal(a.model, "linear_regression");
  assert.equal(a.level, 7);
  assert.equal(a.residualSd, 2);
  for (const other of [b, c, d]) {
    assert.equal(other.model, "moving_average");
    assert.equal(other.level, 10);
  }
});

test("without a usable model every product uses the moving average", () => {
  assert.equal(getProvider(null).engine, "moving_average");
  // A model from before forecasts were stored (version 1) has no forecasts.
  assert.equal(getProvider({ method: "linear_regression", coefficients: [1] }).engine, "moving_average");
});

test("the replenishment reason explains the recommendation", () => {
  const reorder = (over) => ({ dailyDemand: 8, inventoryPosition: 250, reorderPoint: 61, needsReorder: false, ...over });
  assert.match(replenishmentReason({ reorder: reorder(), cover: { status: "out_of_stock" } }, { incoming: 250, awaiting: 0 }, "strips"), /Out of stock now, but 250 strips on the way/);
  assert.match(
    replenishmentReason({ reorder: reorder({ inventoryPosition: 40, needsReorder: true }), cover: { status: "ok" } }, { incoming: 0, awaiting: 50 }, "strips"),
    /^Reorder: .*40 strips.*61.* 50 strips ordered are awaiting warehouse acceptance/
  );
  assert.match(replenishmentReason({ reorder: reorder({ dailyDemand: 0 }), cover: { status: "no_sales" } }, { incoming: 0, awaiting: 0 }, "units"), /No recent demand/);
});
