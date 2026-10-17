// Burn rate, moving-average demand estimate, backtest and consumption change,
// from a daily series [{ date, sold, closingOnHand }] (one entry per calendar
// day, oldest first). `sold` counts sale items only (no returns, stock
// corrections or other movements). closingOnHand is null on days before the
// product was first stocked at the pharmacy.

const { mean, stdDev, sum } = require("./stats");

// Days on which the product was stocked at the pharmacy (it has a ledger entry).
const isStocked = (day) => day.closingOnHand !== null;
// Ended the day with stock (sales were not cut short by a stockout).
const isObserved = (day) => day.closingOnHand !== null && day.closingOnHand > 0;

// Average daily consumption = units sold in the window / days in the window.
//
// The window is the last `windowDays` calendar days. If the product has been
// stocked for fewer days than that, the rate is computed over the days it was
// stocked and the status says the history is insufficient.
// status: no_history | insufficient_history | no_sales | ok
function burnRate(days, windowDays) {
  const recent = days.slice(-windowDays);
  const firstStocked = recent.findIndex(isStocked);
  const window = firstStocked === -1 ? [] : recent.slice(firstStocked);
  const totalSold = sum(window.map((day) => day.sold));
  const status =
    window.length === 0 ? "no_history" : window.length < windowDays ? "insufficient_history" : totalSold === 0 ? "no_sales" : "ok";
  return {
    rate: window.length === 0 ? null : totalSold / window.length,
    status,
    windowDays,
    daysUsed: window.length,
    totalSold,
    // Reported, not excluded: the formula divides by all days in the window.
    stockoutDays: window.filter((day) => day.closingOnHand === 0).length,
    sd: stdDev(window.map((day) => day.sold)),
  };
}

// Moving-average estimate: the burn rate of the last `window` days, used as
// the expected daily demand for every day of the horizon.
function movingAverageForecast(days, { window = 28, horizon = 30 } = {}) {
  const burn = burnRate(days, window);
  const level = burn.rate ?? 0;
  return { forecast: Array(horizon).fill(level), level, residualSd: burn.sd, burn };
}

// Actual vs estimated demand: for each of the last `testDays` days, the
// moving average of the `window` days before it is compared with what was
// actually sold that day. Only days with a full window of history count.
function backtestMovingAverage(days, { window = 28, testDays = 28 } = {}) {
  const firstStocked = days.findIndex(isStocked);
  const points = [];
  if (firstStocked !== -1) {
    for (let t = Math.max(days.length - testDays, firstStocked + window); t < days.length; t++) {
      const estimate = mean(days.slice(t - window, t).map((day) => day.sold));
      points.push({ date: days[t].date, actual: days[t].sold, estimate });
    }
  }
  if (points.length < 7) return { sufficient: false, points, mae: null, rmse: null, bias: null };
  const errors = points.map((p) => p.actual - p.estimate);
  return {
    sufficient: true,
    points,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((e) => e * e))),
    // Positive: demand was higher than estimated.
    bias: mean(errors),
  };
}

// Recent consumption (last `recentDays` days that ended in stock) compared
// with the `baselineDays` such days before them. z uses the standard error
// of a mean of recentDays days.
function consumptionChange(days, { recentDays = 7, baselineDays = 28 } = {}) {
  const observed = days.filter(isObserved).map((day) => day.sold);
  if (observed.length < recentDays + 7) return null;
  const recent = observed.slice(-recentDays);
  const baseline = observed.slice(-(recentDays + baselineDays), -recentDays);
  const recentDaily = mean(recent);
  const baselineDaily = mean(baseline);
  const sd = stdDev(baseline);
  return {
    recentDaily,
    baselineDaily,
    ratio: baselineDaily > 0 ? recentDaily / baselineDaily : null,
    z: sd > 0 ? (recentDaily - baselineDaily) / (sd / Math.sqrt(recentDays)) : null,
  };
}

module.exports = { isStocked, isObserved, burnRate, movingAverageForecast, backtestMovingAverage, consumptionChange };
