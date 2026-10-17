const test = require("node:test");
const assert = require("node:assert/strict");
const { normalQuantile, stdDev } = require("../../src/pharmacy/analytics/stats");
const { burnRate, movingAverageForecast, backtestMovingAverage, consumptionChange } = require("../../src/pharmacy/analytics/demand");
const { computeReorder, explain } = require("../../src/pharmacy/analytics/reorder");
const { depletion, stockCover, stockoutRisk, expiryRisk } = require("../../src/pharmacy/analytics/depletion");
const { buildAlerts } = require("../../src/pharmacy/analytics/alert-rules");
const { getProvider } = require("../../src/pharmacy/analytics/forecast-provider");
const { byFefo, suggestBatch } = require("../../src/pharmacy/fefo");

const TODAY = "2026-10-12";

// Daily series helper: sold[i] with closing stock (default: in stock).
const series = (sold, closing = () => 100) =>
  sold.map((value, i) => ({ date: `d${String(i).padStart(3, "0")}`, sold: value, closingOnHand: typeof closing === "function" ? closing(i) : closing[i] }));

test("normal quantile gives the usual safety factors", () => {
  assert.ok(Math.abs(normalQuantile(0.95) - 1.6449) < 1e-3);
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-9);
  assert.throws(() => normalQuantile(1));
});

test("burn rate = units sold in the window / days in the window (stockout days are counted, not excluded)", () => {
  // 10-day window: 8 days selling 5, 2 days that ended out of stock selling 1.
  const days = series([9, 9, 5, 5, 5, 5, 1, 1, 5, 5, 5, 5], (i) => (i === 6 || i === 7 ? 0 : 50));
  const result = burnRate(days, 10);
  assert.equal(result.totalSold, 42);
  assert.equal(result.rate, 4.2);
  assert.equal(result.daysUsed, 10);
  assert.equal(result.stockoutDays, 2);
  assert.equal(result.status, "ok");
});

test("burn rate statuses: no sales, insufficient history, no history", () => {
  assert.deepEqual(
    (({ rate, status }) => ({ rate, status }))(burnRate(series(Array(28).fill(0)), 28)),
    { rate: 0, status: "no_sales" }
  );
  // Stocked only for the last 3 of 28 days: rate over those 3 days, flagged.
  const recent = burnRate(series([0, 0, 0, 3, 6, 9], [null, null, null, 10, 10, 10]), 28);
  assert.equal(recent.rate, 6);
  assert.equal(recent.daysUsed, 3);
  assert.equal(recent.status, "insufficient_history");
  const none = burnRate(series([0, 0], [null, null]), 28);
  assert.equal(none.rate, null);
  assert.equal(none.status, "no_history");
});

test("moving-average estimate is the burn rate of the window, repeated over the horizon", () => {
  const days = series([...Array(30).fill(2), ...Array(28).fill(6)]);
  const estimate = movingAverageForecast(days, { window: 28, horizon: 5 });
  assert.deepEqual(estimate.forecast, [6, 6, 6, 6, 6]);
  const [fromProvider] = getProvider().forecast({ series: [{ id: "x", days }], horizonDays: 3, windowDays: 28 });
  assert.equal(fromProvider.model, "moving_average");
  assert.deepEqual(fromProvider.forecast, [6, 6, 6]);
});

test("actual vs estimated: each estimate uses only the days before it", () => {
  // Level 4 for 40 days, then 10 for 10 days.
  const days = series([...Array(40).fill(4), ...Array(10).fill(10)]);
  const result = backtestMovingAverage(days, { window: 28, testDays: 10 });
  assert.equal(result.sufficient, true);
  assert.equal(result.points.length, 10);
  // First test day: window is all 4s -> estimate 4, actual 10.
  assert.deepEqual(result.points[0], { date: "d040", actual: 10, estimate: 4 });
  assert.ok(result.bias > 0, "demand above the estimate");
  // Too little history for a full window: not enough points.
  assert.equal(backtestMovingAverage(series([1, 2, 3, 4, 5]), { window: 28, testDays: 10 }).sufficient, false);
});

test("stock cover = usable available stock / daily consumption, with meaningful statuses", () => {
  assert.deepEqual(stockCover(50, { rate: 5, status: "ok" }), { days: 10, status: "ok", provisional: false });
  assert.deepEqual(stockCover(50, { rate: 0, status: "no_sales" }), { days: null, status: "no_sales", provisional: false });
  assert.deepEqual(stockCover(50, { rate: null, status: "no_history" }), { days: null, status: "no_history", provisional: true });
  assert.deepEqual(stockCover(0, { rate: 5, status: "ok" }), { days: 0, status: "out_of_stock", provisional: false });
  assert.equal(stockCover(30, { rate: 3, status: "insufficient_history" }).provisional, true);
});

const BASE = {
  forecast: Array(30).fill(10),
  demandSd: 3,
  leadTimeDays: 3,
  reviewPeriodDays: 7,
  safety: { method: "service_level", serviceLevel: 0.95 },
  onHandUsable: 40,
  reserved: 0,
  incoming: 0,
  unitsPerPack: 20,
  minOrderPacks: 1,
};

test("Q*: IP, reorder point, target stock and Q* = max(0, S - IP) follow the stated formulas", () => {
  const r = computeReorder(BASE);
  const ss = normalQuantile(0.95) * 3 * Math.sqrt(10);
  assert.equal(r.leadTimeDemand, 30);
  assert.equal(r.reviewPeriodDemand, 70);
  assert.ok(Math.abs(r.reorderPoint - (30 + ss)) < 1e-9);
  assert.ok(Math.abs(r.targetStock - (100 + ss)) < 1e-9);
  assert.equal(r.inventoryPosition, 40);
  assert.equal(r.needsReorder, true);
  assert.ok(Math.abs(r.rawQuantity - (100 + ss - 40)) < 1e-9);
  // 75.6 -> 76 units -> 4 packs of 20.
  assert.equal(r.recommendedPacks, 4);
  assert.equal(r.recommendedUnits, 80);
  assert.equal(r.constraints[0].type, "pack_size");
});

test("Q*: incoming adds to and reserved subtracts from the position; above the reorder point Q* is still S - IP", () => {
  const r = computeReorder({ ...BASE, incoming: 60, reserved: 10 });
  assert.equal(r.inventoryPosition, 90);
  assert.equal(r.needsReorder, false);
  // S ~ 115.6 - 90 = 25.6 -> 2 packs.
  assert.equal(r.recommendedPacks, 2);
  const full = computeReorder({ ...BASE, onHandUsable: 200 });
  assert.equal(full.rawQuantity, 0);
  assert.equal(full.recommendedPacks, 0);
});

test("Q*: no demand and no safety stock means no order", () => {
  const r = computeReorder({ ...BASE, forecast: Array(30).fill(0), demandSd: 0, onHandUsable: 0 });
  assert.equal(r.targetStock, 0);
  assert.equal(r.needsReorder, false);
  assert.equal(r.recommendedUnits, 0);
});

test("Q*: minimum order, storage capacity and safety-stock methods", () => {
  assert.equal(computeReorder({ ...BASE, minOrderPacks: 6 }).recommendedPacks, 6);
  const capped = computeReorder({ ...BASE, maxStockUnits: 100 });
  assert.equal(capped.recommendedPacks, 3);
  assert.ok(capped.constraints.some((c) => c.type === "storage_capacity"));
  assert.equal(computeReorder({ ...BASE, safety: { method: "days_of_cover", safetyDays: 5 } }).safetyStock, 50);
  assert.equal(computeReorder({ ...BASE, safety: { method: "fixed_units", safetyUnits: 12 } }).safetyStock, 12);
});

test("the explanation shows every step of the calculation", () => {
  const r = computeReorder({ ...BASE, safety: { method: "fixed_units", safetyUnits: 10 } });
  const text = explain({ result: r, unitLabel: "strips", packLabel: "carton(s)", windowDays: 28, leadTimeDays: 3, reviewPeriodDays: 7, onHandUsable: 40, incoming: 0, reserved: 0 });
  assert.match(text, /10 strips\/day \(units sold in the last 28 days \/ 28\)/);
  assert.match(text, /Reorder point = 30 \+ 10 = 40/);
  assert.match(text, /Inventory position = 40 usable on hand \+ 0 incoming - 0 reserved = 40/);
  assert.match(text, /Q\* = max\(0, 110 - 40\) = 70 units/);
  assert.match(text, /Order 4 carton\(s\) \(80 strips\)/);
  assert.match(text, /reorder now/);
});

test("depletion and stockout risk", () => {
  assert.deepEqual(depletion(25, [10, 10, 10, 10], TODAY), { daysOfCover: 2.5, stockoutDate: "2026-10-14" });
  assert.deepEqual(depletion(10, [0, 0, 0], TODAY), { daysOfCover: null, stockoutDate: null });
  assert.equal(stockoutRisk({ positionCover: 1, leadTimeDays: 3, reviewPeriodDays: 7 }), "high");
  assert.equal(stockoutRisk({ positionCover: 40, leadTimeDays: 3, reviewPeriodDays: 7 }), "none");
});

test("expiry risk: FEFO simulation finds stock that cannot sell before expiry", () => {
  const risk = expiryRisk(
    [
      { batchId: "B", available: 30, expiryDate: "2027-01-01" },
      { batchId: "A", available: 50, expiryDate: "2026-10-15" },
    ],
    Array(30).fill(10),
    TODAY
  );
  assert.equal(risk.units, 10);
  assert.deepEqual(risk.batches.map((b) => b.batchId), ["A"]);
});

test("FEFO: sellable batches first, earliest expiry first; a sellable scanned batch wins", () => {
  const batches = [
    { batchId: "late", batchNumber: "L", sellable: true, expiryDate: "2027-06-01" },
    { batchId: "expired", batchNumber: "X", sellable: false, expiryDate: "2026-09-01" },
    { batchId: "soon", batchNumber: "S", sellable: true, expiryDate: "2026-12-01" },
    { batchId: "reserved", batchNumber: "R", sellable: false, expiryDate: "2026-11-01" },
  ];
  assert.deepEqual([...batches].sort(byFefo).map((b) => b.batchId), ["soon", "late", "expired", "reserved"]);
  assert.equal(suggestBatch(batches).batchId, "soon");
  assert.equal(suggestBatch(batches, "late").batchId, "late");
  assert.equal(suggestBatch(batches, "expired").batchId, "soon", "an unsellable scanned batch falls back to FEFO");
  assert.equal(suggestBatch(batches.filter((b) => !b.sellable)), null);
});

test("alerts: out of stock, low stock, reorder (critical when stock will not last the lead time), expiry, spike", () => {
  const alerts = buildAlerts({
    nearExpiryDays: 90,
    products: [
      { medicineId: "m1", name: "Paracetamol", unitLabel: "strips", available: 0, lowStockThreshold: 50 },
      {
        medicineId: "m2",
        name: "Amoxicillin",
        unitLabel: "strips",
        available: 20,
        lowStockThreshold: 30,
        recommendation: { needsReorder: true, recommendedPacks: 2, packLabel: "carton(s)", leadTimeDays: 3, daysOfCover: 2, inventoryPosition: 20, reorderPoint: 60 },
        consumption: { recentDaily: 20, baselineDaily: 8, ratio: 2.5, z: 6 },
      },
      {
        medicineId: "m3",
        name: "ORS",
        unitLabel: "sachets",
        available: 200,
        lowStockThreshold: 30,
        recommendation: { needsReorder: true, recommendedPacks: 1, packLabel: "carton(s)", leadTimeDays: 3, daysOfCover: 20, inventoryPosition: 200, reorderPoint: 210 },
      },
      { medicineId: "m4", name: "Saline", unitLabel: "bottles", available: 0, tracked: false, lowStockThreshold: 5, recommendation: { needsReorder: true, recommendedPacks: 1 } },
    ],
    batches: [
      { batchId: "b1", medicineId: "m3", name: "ORS", batchNumber: "X", expiryDate: "2026-10-01", daysToExpiry: -11, available: 6 },
      { batchId: "b2", medicineId: "m3", name: "ORS", batchNumber: "A", expiryDate: "2026-11-01", daysToExpiry: 20, available: 50 },
      { batchId: "b3", medicineId: "m3", name: "ORS", batchNumber: "B", expiryDate: "2026-12-30", daysToExpiry: 79, available: 50 },
    ],
  });
  const keys = Object.fromEntries(alerts.map((a) => [a.dedupe_key, a.severity]));
  assert.deepEqual(keys, {
    "low_stock:m1": "critical",
    "low_stock:m2": "warning",
    "reorder:m2": "critical",
    "unusual_consumption:m2": "warning",
    "reorder:m3": "warning",
    "expired:b1": "critical",
    "near_expiry:b2": "critical",
    "near_expiry:b3": "warning",
  });
  assert.match(alerts.find((a) => a.dedupe_key === "reorder:m2").title, /Reorder Amoxicillin: 2 carton\(s\)/);
});

test("consumption change detects a spike; standard deviation is the sample deviation", () => {
  const base = Array.from({ length: 28 }, (_, i) => (i % 2 ? 9 : 11));
  const change = consumptionChange(series([...base, 25, 24, 26, 25, 27, 23, 25]));
  assert.equal(change.ratio, 2.5);
  assert.equal(stdDev([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(4), "2.1381");
});
