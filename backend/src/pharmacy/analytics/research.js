// Research evaluation metrics for one pharmacy, computed from application
// data only (sales, stock ledger, forecasts, recommendations, returns).
// Every response says how much of the data is synthetic seed data, so demo
// values are never presented as experimental findings.

const { supabase, today, addDays, fetchAll, getInventory, getDailyDemand, getMedicines } = require("../store");
const { unwrap } = require("../errors");
const { daysBetween } = require("../dates");
const { mean, round } = require("./stats");

// Actual vs estimated demand of the latest run: for each product, the moving
// average of the window before each of the last days compared with what was
// actually sold (measured on recorded sales; no model accuracy is assumed).
function estimateAccuracy(run) {
  if (!run || run.engine !== "moving_average") return null;
  const products = (run.evaluation ?? [])
    .filter((e) => e.backtest)
    .map((e) => ({
      medicineId: e.medicine_id,
      name: e.medicine_name,
      days: e.backtest.days,
      mae: e.backtest.mae,
      rmse: e.backtest.rmse,
      bias: e.backtest.bias,
      totalSold: e.total_sold,
    }));
  return {
    runId: run.id,
    runAt: run.finished_at,
    windowDays: run.summary?.window_days ?? null,
    testDays: run.test_days,
    dataNote: run.data_note,
    products,
    productsInRun: (run.evaluation ?? []).length,
    insufficient: (run.evaluation ?? []).filter((e) => !e.backtest).length,
    meanMae: products.length ? round(mean(products.map((p) => p.mae)), 3) : null,
  };
}

async function researchMetrics(pharmacy, { days = 90 } = {}) {
  const todayISO = today();
  const from = addDays(todayISO, -days);
  const to = addDays(todayISO, -1);
  const fromTs = `${from}T00:00:00+05:30`;

  const [demandRows, inventory, medicines, saleItems, decisions, latestRun, pastForecasts, returnItems] = await Promise.all([
    getDailyDemand(pharmacy.id, from, to),
    getInventory(pharmacy.id),
    getMedicines({ activeOnly: false }),
    fetchAll(() =>
      supabase
        .from("sale_items")
        .select("medicine_id, quantity, line_total, sold_at, inventory:pharmacy_inventory(unit_cost), sale:sales(source)")
        .eq("pharmacy_id", pharmacy.id)
        .gte("sold_at", fromTs)
        .order("id")
    ),
    fetchAll(() =>
      supabase
        .from("reorder_recommendations")
        .select("status, recommended_packs, decided_packs, decided_at, generated_at")
        .eq("pharmacy_id", pharmacy.id)
        .gte("generated_at", fromTs)
        .order("id")
    ),
    supabase
      .from("pharmacy_forecast_runs")
      .select("id, engine, test_days, evaluation, summary, data_note, finished_at")
      .eq("pharmacy_id", pharmacy.id)
      .eq("status", "completed")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(unwrap),
    fetchAll(() =>
      supabase
        .from("pharmacy_demand_forecasts")
        .select("medicine_id, forecast_date, predicted_quantity, model_name")
        .eq("model_name", "moving_average")
        .eq("pharmacy_id", pharmacy.id)
        .gte("forecast_date", from)
        .lt("forecast_date", todayISO)
        .order("id")
    ),
    fetchAll(() =>
      supabase
        .from("return_items")
        .select("quantity, reason, medicine_id, request:return_requests!inner(status, requested_at)")
        .eq("pharmacy_id", pharmacy.id)
        .gte("request.requested_at", fromTs)
        .order("id")
    ),
  ]);
  const medicineById = new Map(medicines.map((m) => [m.id, m]));
  const costOf = (medicineId) => Number(medicineById.get(medicineId)?.unit_cost ?? 0);

  // Data provenance.
  const syntheticUnits = saleItems.filter((i) => i.sale?.source === "synthetic_seed").reduce((t, i) => t + i.quantity, 0);
  const totalUnits = saleItems.reduce((t, i) => t + i.quantity, 0);
  const provenance = {
    windowDays: days,
    from,
    to,
    saleLines: saleItems.length,
    syntheticShare: totalUnits === 0 ? 0 : round(syntheticUnits / totalUnits, 3),
    posUnits: totalUnits - syntheticUnits,
    syntheticUnits,
  };

  // Stockout rate: product-days that ended with no stock, among days whose
  // closing stock is known.
  const known = demandRows.filter((r) => r.closing_on_hand !== null);
  const stockoutDays = known.filter((r) => r.closing_on_hand === 0);
  const stockoutByProduct = Object.values(
    known.reduce((acc, r) => {
      acc[r.medicine_id] ??= { medicineId: r.medicine_id, name: medicineById.get(r.medicine_id)?.name, days: 0, stockoutDays: 0 };
      acc[r.medicine_id].days += 1;
      if (r.closing_on_hand === 0) acc[r.medicine_id].stockoutDays += 1;
      return acc;
    }, {})
  ).map((p) => ({ ...p, rate: round(p.stockoutDays / p.days, 3) }));

  // Live (realised) forecast accuracy: past forecasts vs what was then sold,
  // on days that ended in stock.
  const actual = new Map(demandRows.map((r) => [`${r.medicine_id}|${r.day}`, r]));
  const liveErrors = {};
  for (const f of pastForecasts) {
    const row = actual.get(`${f.medicine_id}|${f.forecast_date}`);
    if (!row || !(row.closing_on_hand > 0)) continue;
    (liveErrors[f.model_name] ??= []).push(Math.abs(row.quantity_sold - Number(f.predicted_quantity)));
  }
  const liveAccuracy = Object.fromEntries(
    Object.entries(liveErrors).map(([model, errors]) => [model, { points: errors.length, mae: round(mean(errors), 3) }])
  );

  // Expiry exposure now, and expiry-related returns in the window.
  const exposure = { expired: { units: 0, value: 0 }, critical: { units: 0, value: 0 }, nearExpiry: { units: 0, value: 0 } };
  for (const row of inventory) {
    const unitsLeft = row.quantity_on_hand;
    if (unitsLeft <= 0) continue;
    const d = daysBetween(todayISO, row.expiry_date);
    const bucket = d < 0 ? "expired" : d <= 30 ? "critical" : d <= pharmacy.near_expiry_days ? "nearExpiry" : null;
    if (!bucket) continue;
    exposure[bucket].units += unitsLeft;
    exposure[bucket].value += unitsLeft * Number(row.unit_cost ?? 0);
  }
  for (const bucket of Object.values(exposure)) bucket.value = round(bucket.value, 2);
  const expiredReturned = returnItems.filter((r) => r.reason === "expired").reduce((t, r) => t + r.quantity, 0);
  const nearExpiryReturned = returnItems.filter((r) => r.reason === "near_expiry").reduce((t, r) => t + r.quantity, 0);

  // Inventory turnover = cost of goods sold / average inventory value.
  const cogs = saleItems.reduce((t, i) => t + i.quantity * Number(i.inventory?.unit_cost ?? costOf(i.medicine_id)), 0);
  const stockValueByDay = new Map();
  const stockUnitsByDay = new Map();
  for (const r of known) {
    stockValueByDay.set(r.day, (stockValueByDay.get(r.day) ?? 0) + r.closing_on_hand * costOf(r.medicine_id));
    stockUnitsByDay.set(r.day, (stockUnitsByDay.get(r.day) ?? 0) + r.closing_on_hand);
  }
  const avgInventoryValue = mean([...stockValueByDay.values()]) ?? 0;
  const turnover = avgInventoryValue > 0 ? cogs / avgInventoryValue : null;

  // Recommendation decisions.
  const decided = decisions.filter((d) => ["accepted", "edited", "rejected"].includes(d.status));
  const count = (status) => decided.filter((d) => d.status === status).length;
  const edits = decided.filter((d) => d.status === "edited").map((d) => Math.abs(d.decided_packs - d.recommended_packs));
  const acceptance = {
    generated: decisions.length,
    decided: decided.length,
    accepted: count("accepted"),
    edited: count("edited"),
    rejected: count("rejected"),
    pending: decisions.filter((d) => d.status === "pending").length,
    superseded: decisions.filter((d) => d.status === "superseded").length,
    acceptanceRate: decided.length ? round((count("accepted") + count("edited")) / decided.length, 3) : null,
    unchangedRate: decided.length ? round(count("accepted") / decided.length, 3) : null,
    meanEditPacks: edits.length ? round(mean(edits), 2) : null,
  };

  // Excess stock: available beyond the target stock of the current recommendation.
  const pending = unwrap(
    await supabase
      .from("reorder_recommendations")
      .select("medicine_id, target_stock, days_of_cover, lead_time_days, review_period_days, on_hand_usable, reserved")
      .eq("pharmacy_id", pharmacy.id)
      .eq("status", "pending")
  );
  const excess = pending
    .map((r) => {
      const available = r.on_hand_usable - r.reserved;
      const units = Math.max(0, Math.round(available - Number(r.target_stock)));
      const cover = r.days_of_cover === null ? null : Number(r.days_of_cover);
      return {
        medicineId: r.medicine_id,
        name: medicineById.get(r.medicine_id)?.name,
        excessUnits: units,
        excessValue: round(units * costOf(r.medicine_id), 2),
        daysOfCover: cover,
        flagged: units > 0 && (cover === null || cover > 3 * (r.lead_time_days + r.review_period_days)),
      };
    })
    .filter((e) => e.excessUnits > 0);

  // Weekly sales (units, revenue, by source) and daily stock on hand.
  const weekly = new Map();
  for (const item of saleItems) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date(item.sold_at));
    const week = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
    const w = weekly.get(week) ?? { week, units: 0, revenue: 0, syntheticUnits: 0 };
    w.units += item.quantity;
    w.revenue += Number(item.line_total);
    if (item.sale?.source === "synthetic_seed") w.syntheticUnits += item.quantity;
    weekly.set(week, w);
  }

  return {
    pharmacyId: pharmacy.id,
    provenance,
    estimateAccuracy: estimateAccuracy(latestRun),
    liveAccuracy,
    stockout: {
      productDays: known.length,
      stockoutDays: stockoutDays.length,
      rate: known.length ? round(stockoutDays.length / known.length, 4) : null,
      byProduct: stockoutByProduct.sort((a, b) => b.rate - a.rate),
    },
    expiry: { ...exposure, expiredReturnedUnits: expiredReturned, nearExpiryReturnedUnits: nearExpiryReturned },
    turnover: {
      cogs: round(cogs, 2),
      averageInventoryValue: round(avgInventoryValue, 2),
      turnover: round(turnover, 2),
      annualisedTurnover: turnover === null ? null : round((turnover * 365) / days, 2),
      daysOfInventory: cogs > 0 ? round(avgInventoryValue / (cogs / days), 1) : null,
    },
    acceptance,
    excess: { products: excess.length, flagged: excess.filter((e) => e.flagged).length, units: excess.reduce((t, e) => t + e.excessUnits, 0), value: round(excess.reduce((t, e) => t + e.excessValue, 0), 2), items: excess },
    trends: {
      weeklySales: [...weekly.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map((w) => ({ ...w, revenue: round(w.revenue, 2) })),
      dailyStock: [...stockUnitsByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, units]) => ({ day, units })),
    },
  };
}

module.exports = { researchMetrics, estimateAccuracy };
