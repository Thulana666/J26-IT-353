// Pooled linear regression for next-day demand per medicine.
//
// One model for all products of a pharmacy. Each product's figures are divided
// by its own average of the previous 28 days ("scale"), so fast and slow movers
// share one set of coefficients:
//
//   sold[t] / scale  ~  b0 + b1 * sold[t-1]/scale + b2 * sold[t-7]/scale
//                       + b3 * mean(sold[t-7..t-1])/scale + day-of-week terms
//
// Every feature uses only days before t (no leakage); current stock is never a
// feature. Days that ended out of stock are not used as targets, because their
// sales were cut short (censored demand). Fitted by least squares with a small
// ridge penalty (intercept not penalised) for stability.
//
// Evaluation is chronological: the last `testDays` days are held out, the model
// is fitted on the days before them, and both the model and the 28-day moving
// average (the app's baseline) predict each held-out day one step ahead.

const { mean } = require("./stats");
const { addDays } = require("../dates");
const { isObserved, isStocked } = require("./demand");

const LOOKBACK = 28;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat"]; // Sunday is the reference day
const FEATURES = ["intercept", "lag1", "lag7", "mean7", ...DAYS];

const dayOfWeek = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// Features for day t from sold[t-28..t-1]; null when there is no usable history.
function featuresAt(sold, t, date) {
  if (t < LOOKBACK) return null;
  const scale = mean(sold.slice(t - LOOKBACK, t));
  if (!(scale > 0)) return null;
  const d = dayOfWeek(date);
  return {
    scale,
    x: [1, sold[t - 1] / scale, sold[t - 7] / scale, mean(sold.slice(t - 7, t)) / scale, ...DAYS.map((_, i) => (d === i + 1 ? 1 : 0))],
  };
}

// Training rows of one series [{ date, sold, closingOnHand }] (one per calendar day).
function seriesRows(id, days) {
  const sold = days.map((d) => d.sold);
  const rows = [];
  for (let t = LOOKBACK; t < days.length; t++) {
    if (!isObserved(days[t])) continue;
    if (!days.slice(t - LOOKBACK, t).every(isStocked)) continue;
    const f = featuresAt(sold, t, days[t].date);
    if (!f) continue;
    rows.push({ id, date: days[t].date, x: f.x, y: days[t].sold / f.scale, scale: f.scale, actual: days[t].sold });
  }
  return rows;
}

// Solves A b = c by Gaussian elimination with partial pivoting.
function solve(A, c) {
  const n = c.length;
  const M = A.map((row, i) => [...row, c[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error("The training data does not determine the model (singular system)");
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= factor * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Least squares with ridge penalty lambda on every coefficient except the intercept.
function fitRidge(rows, lambda = 1) {
  const p = rows[0].x.length;
  const A = Array.from({ length: p }, () => Array(p).fill(0));
  const c = Array(p).fill(0);
  for (const { x, y } of rows) {
    for (let i = 0; i < p; i++) {
      c[i] += x[i] * y;
      for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < p; i++) A[i][i] += lambda;
  return solve(A, c);
}

const dot = (a, b) => a.reduce((t, v, i) => t + v * b[i], 0);
// Demand in units; never negative.
const predictUnits = (coefficients, x, scale) => Math.max(0, scale * dot(coefficients, x));

const metrics = (errors) =>
  errors.length === 0
    ? { mae: null, rmse: null }
    : { mae: mean(errors.map(Math.abs)), rmse: Math.sqrt(mean(errors.map((e) => e * e))) };

// Chronological holdout over series [{ id, days }].
// Returns null when there is not enough data for a meaningful evaluation.
function evaluateHoldout(series, { testDays = 28, lambda = 1, minTrainRows = 100, minTestRows = 28 } = {}) {
  const rows = series.flatMap(({ id, days }) => seriesRows(id, days));
  if (rows.length === 0) return null;
  const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date);
  const cutDate = addDays(lastDate, -(testDays - 1));
  const train = rows.filter((r) => r.date < cutDate);
  const test = rows.filter((r) => r.date >= cutDate);
  if (train.length < minTrainRows || test.length < minTestRows) return null;

  const coefficients = fitRidge(train, lambda);
  const points = test.map((r) => ({ id: r.id, date: r.date, actual: r.actual, model: predictUnits(coefficients, r.x, r.scale), baseline: r.scale }));
  const perSeries = {};
  for (const { id } of series) {
    const own = points.filter((p) => p.id === id);
    const errors = own.map((p) => p.actual - p.model);
    perSeries[id] = {
      observations: own.length,
      linearRegression: metrics(errors),
      movingAverage: metrics(own.map((p) => p.actual - p.baseline)),
      residualSd: own.length > 1 ? Math.sqrt(errors.reduce((t, e) => t + (e - mean(errors)) ** 2, 0) / (own.length - 1)) : null,
    };
  }
  return {
    coefficients,
    train: { observations: train.length, from: train.reduce((m, r) => (r.date < m ? r.date : m), train[0].date), to: addDays(cutDate, -1) },
    test: { observations: test.length, from: cutDate, to: lastDate },
    overall: { linearRegression: metrics(points.map((p) => p.actual - p.model)), movingAverage: metrics(points.map((p) => p.actual - p.baseline)) },
    perSeries,
    points,
    allRows: rows,
  };
}

// Forecast of the next `horizon` days after the last day of `days`, feeding each
// prediction into the next day's features. null when the recent history cannot
// support it (fewer than 28 stocked days, or no sales in them).
function forecastRecursive(coefficients, days, horizon) {
  if (days.length < LOOKBACK || !days.slice(-LOOKBACK).every(isStocked)) return null;
  const sold = days.map((d) => d.sold);
  const lastDate = days[days.length - 1].date;
  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const f = featuresAt(sold, sold.length, addDays(lastDate, h));
    if (!f) return null;
    const value = predictUnits(coefficients, f.x, f.scale);
    forecast.push(value);
    sold.push(value);
  }
  return forecast;
}

module.exports = { LOOKBACK, FEATURES, featuresAt, seriesRows, fitRidge, solve, predictUnits, evaluateHoldout, forecastRecursive };
