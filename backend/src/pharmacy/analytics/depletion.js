// Stock depletion, stockout risk and expiry risk from a daily forecast
// (day 0 = today, dispensing units).

const { mean } = require("./stats");
const { addDays } = require("../dates");

const MAX_SIMULATION_DAYS = 730;

// Days until `stock` runs out at the forecast rate, and the date it runs out.
// Beyond the forecast horizon the mean forecast is used. No demand: null.
function depletion(stock, forecast, today) {
  if (stock <= 0) return { daysOfCover: 0, stockoutDate: today };
  const level = mean(forecast) ?? 0;
  let remaining = stock;
  for (let day = 0; day < forecast.length; day++) {
    const demand = forecast[day];
    if (demand >= remaining && demand > 0) {
      return { daysOfCover: day + remaining / demand, stockoutDate: addDays(today, day) };
    }
    remaining -= demand;
  }
  if (level <= 0) return { daysOfCover: null, stockoutDate: null };
  const days = forecast.length + remaining / level;
  return { daysOfCover: days, stockoutDate: days > MAX_SIMULATION_DAYS ? null : addDays(today, Math.floor(days)) };
}

// Days of stock cover = usable available stock / average daily consumption.
// burn: result of burnRate(). Never returns an infinite or made-up number:
//   out_of_stock (0 days) | no_history | no_sales | ok (+ insufficient_history flag)
function stockCover(available, burn) {
  if (available <= 0) return { days: 0, status: "out_of_stock", provisional: false };
  if (!burn || burn.rate === null) return { days: null, status: "no_history", provisional: true };
  if (burn.rate === 0) return { days: null, status: "no_sales", provisional: burn.status === "insufficient_history" };
  return { days: available / burn.rate, status: "ok", provisional: burn.status === "insufficient_history" };
}

// high:   the inventory position runs out before an order placed today can arrive
// medium: it runs out before the next review's order can arrive
// low:    it lasts less than a week beyond that
// none:   otherwise, or no demand
function stockoutRisk({ positionCover, leadTimeDays, reviewPeriodDays }) {
  if (positionCover === null) return "none";
  if (positionCover < Math.max(leadTimeDays, 1)) return "high";
  if (positionCover < leadTimeDays + reviewPeriodDays) return "medium";
  if (positionCover < leadTimeDays + reviewPeriodDays + 7) return "low";
  return "none";
}

// Sells the forecast demand earliest-expiry-first (FEFO) and counts the units
// still left in each batch after its expiry date: stock likely to expire
// before it can be sold. batches: [{ batchId, available, expiryDate }].
function expiryRisk(batches, forecast, today) {
  const level = mean(forecast) ?? 0;
  const queue = batches
    .filter((batch) => batch.available > 0)
    .map((batch) => ({ ...batch, left: batch.available }))
    .sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : a.expiryDate > b.expiryDate ? 1 : 0));
  const atRisk = [];
  for (let day = 0; queue.length > 0 && day < MAX_SIMULATION_DAYS; day++) {
    const date = addDays(today, day);
    // A batch can be sold up to and including its expiry date.
    while (queue.length > 0 && queue[0].expiryDate < date) {
      const expired = queue.shift();
      if (expired.left > 0.5) atRisk.push({ batchId: expired.batchId, expiryDate: expired.expiryDate, units: Math.round(expired.left) });
    }
    let demand = forecast[day] ?? level;
    if (demand <= 0 && day >= forecast.length) break;
    while (demand > 0 && queue.length > 0) {
      const take = Math.min(demand, queue[0].left);
      queue[0].left -= take;
      demand -= take;
      if (queue[0].left <= 1e-9) queue.shift();
    }
  }
  // No more demand: what is left and expires within the simulated period will
  // expire unsold.
  const end = addDays(today, MAX_SIMULATION_DAYS);
  for (const batch of queue) {
    if (batch.expiryDate < end && batch.left > 0.5) atRisk.push({ batchId: batch.batchId, expiryDate: batch.expiryDate, units: Math.round(batch.left) });
  }
  return { units: atRisk.reduce((total, batch) => total + batch.units, 0), batches: atRisk };
}

module.exports = { depletion, stockCover, stockoutRisk, expiryRisk };
