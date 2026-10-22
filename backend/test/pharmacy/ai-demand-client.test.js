const test = require("node:test");
const assert = require("node:assert/strict");
const { trainOnAiService } = require("../../src/pharmacy/analytics/ai-demand-client");

const HORIZON = 30;
const series = [
  { id: "a", days: [{ date: "2026-10-01", sold: 5, closingOnHand: 40 }] },
  { id: "b", days: [{ date: "2026-10-01", sold: 1, closingOnHand: null }] },
];
const metrics = { mae: 1.5, rmse: 2 };
const trained = () => ({
  status: "trained",
  method: "linear_regression",
  features: ["intercept", "lag1", "lag7", "mean7", "mon", "tue", "wed", "thu", "fri", "sat"],
  coefficients: [0.4, 0.05, -0.05, 0.2, 0.5, 0.4, 0.4, 0.3, 0.5, 0.3],
  lambda: 1,
  lookbackDays: 28,
  rows: 300,
  evaluation: {
    train: { observations: 250, from: "2026-05-01", to: "2026-09-11" },
    test: { observations: 50, from: "2026-09-12", to: "2026-10-09" },
    overall: { linearRegression: metrics, movingAverage: { mae: 2, rmse: 2.5 } },
    perSeries: {
      a: { observations: 28, linearRegression: metrics, movingAverage: metrics, residualSd: 1.2, selected: true },
      b: { observations: 0, linearRegression: { mae: null, rmse: null }, movingAverage: { mae: null, rmse: null }, residualSd: null, selected: false },
    },
  },
  forecasts: { a: { start: "2026-10-21", values: Array(HORIZON).fill(4.2) }, b: null },
  library: { scikitLearn: "1.9.1", numpy: "2.5.4" },
});
const realFetch = global.fetch;
const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const call = () => trainOnAiService(series, { testDays: 28, lambda: 1, horizonDays: HORIZON, trainFrom: "2026-04-13", trainTo: "2026-10-09" });

test.afterEach(() => {
  global.fetch = realFetch;
});

test("a valid result from the AI service is used; the request carries the series, window and horizon", async () => {
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body) };
    return respond(200, trained())();
  };
  const { result, fallback } = await call();
  assert.equal(fallback, undefined);
  assert.equal(result.forecasts.a.values.length, HORIZON);
  assert.match(sent.url, /\/pharmacy-demand\/train$/);
  assert.equal(sent.body.series.length, 2);
  assert.deepEqual(Object.keys(sent.body.series[0].days[0]).sort(), ["closingOnHand", "date", "sold"]);
  assert.equal(sent.body.trainTo, "2026-10-09");
  assert.equal(sent.body.horizonDays, HORIZON);
});

test("insufficient history reported by the service is passed on, not treated as a failure", async () => {
  global.fetch = respond(200, { status: "insufficient_history" });
  assert.deepEqual(await call(), { result: { status: "insufficient_history" } });
});

test("unreachable, failing or malformed answers give a fallback with a reason", async () => {
  global.fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  assert.equal((await call()).fallback.reason, "ai_service_unreachable");

  global.fetch = respond(422, { detail: { reason: "training_failed" } });
  assert.equal((await call()).fallback.reason, "ai_service_error");

  const bad = (change) => respond(200, change(trained()));
  for (const change of [
    (b) => ({ ...b, coefficients: [1, 2, 3] }),
    (b) => ({ ...b, coefficients: b.coefficients.map(() => Number.NaN) }),
    (b) => ({ ...b, forecasts: { a: { start: "2026-10-21", values: [1, 2] } } }),
    (b) => ({ ...b, forecasts: { a: { start: "2026-10-21", values: Array(HORIZON).fill(-1) } } }),
    (b) => ({ ...b, evaluation: { ...b.evaluation, perSeries: { a: { ...b.evaluation.perSeries.a, selected: "yes" } } } }),
  ]) {
    global.fetch = bad(change);
    assert.equal((await call()).fallback.reason, "invalid_response");
  }
});
