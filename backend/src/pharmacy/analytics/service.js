// Demand estimates, reorder recommendations and alerts for one pharmacy.
//
// runForecast():
//   1. daily units sold per product from the pharmacy's own sale items, with
//      the closing stock of each day from the stock ledger
//      (pharmacy_daily_demand()),
//   2. a moving-average demand estimate per product (forecast-provider.js;
//      replaceable by a future ML provider with the same interface),
//   3. burn rate, stock cover, Q*, stockout and expiry risk per product, and an
//      actual-versus-estimated backtest of the moving average,
//   4. stores the run, the estimates and the recommendations, then refreshes
//      alerts. Re-running it after new sales and receipts updates everything.

const { supabase, today, addDays, rpc, getInventory, getIncomingUnits, getDailyDemand, getReorderSettings, getMedicines } = require("../store");
const { unwrap } = require("../errors");
const { daysBetween } = require("../dates");
const { round } = require("./stats");
const { getProvider } = require("./forecast-provider");
const { backtestMovingAverage, consumptionChange } = require("./demand");
const { computeReorder, explain } = require("./reorder");
const { depletion, stockCover, stockoutRisk, expiryRisk } = require("./depletion");
const { buildAlerts } = require("./alert-rules");

const HISTORY_DAYS = Number(process.env.PHARMACY_HISTORY_DAYS) || 180;
const HORIZON_DAYS = 30;
const BACKTEST_DAYS = 28;

// "strip of 10 tablets" -> "strips", "single-dose vial" -> "vials".
function unitLabelOf(product) {
  if (!product?.dispensing_unit) return "units";
  const word = product.dispensing_unit.split(/\s+of\s+|\(/)[0].trim().split(/\s+/).pop();
  return word.endsWith("s") ? word : `${word}s`;
}

// Settings for a product: its reorder_settings row, else the pharmacy defaults.
function resolveSettings(pharmacy, row) {
  return {
    leadTimeDays: row?.lead_time_days ?? pharmacy.default_lead_time_days,
    reviewPeriodDays: row?.review_period_days ?? pharmacy.default_review_period_days,
    windowDays: pharmacy.burn_rate_window_days,
    safety: {
      method: row?.safety_stock_method ?? "service_level",
      serviceLevel: Number(row?.service_level ?? pharmacy.default_service_level),
      safetyDays: row?.safety_stock_days === null || row?.safety_stock_days === undefined ? null : Number(row.safety_stock_days),
      safetyUnits: row?.safety_stock_units ?? null,
    },
    lowStockThreshold: row?.low_stock_threshold ?? null,
    minOrderPacks: row?.min_order_packs ?? 1,
    maxStockUnits: row?.max_stock_units ?? null,
    isActive: row?.is_active ?? true,
  };
}

// Current stock of one product. Usable = active (not recalled/quarantined),
// unexpired batches, minus units held by discrepancy reports (disputed,
// damaged or missing). Disputed shipment items are never added at all.
// Reserved units (held for returns) are subtracted once in the position.
function stockOf(rows, todayISO) {
  const usable = rows.filter((row) => row.batch_status === "active" && row.expiry_date >= todayISO);
  return {
    onHandUsable: usable.reduce((total, row) => total + row.quantity_on_hand - (row.quantity_held ?? 0), 0),
    held: rows.reduce((total, row) => total + (row.quantity_held ?? 0), 0),
    reserved: usable.reduce((total, row) => total + row.quantity_reserved, 0),
    available: usable.reduce((total, row) => total + row.quantity_available, 0),
    batches: usable.map((row) => ({ batchId: row.batch_id, available: row.quantity_available, expiryDate: row.expiry_date })),
  };
}

// Everything the analytics need about the pharmacy's products.
async function loadState(pharmacy, historyDays = HISTORY_DAYS) {
  const todayISO = today();
  const from = addDays(todayISO, -historyDays);
  const to = addDays(todayISO, -1);
  const [inventory, incoming, settings, demandRows, medicines] = await Promise.all([
    getInventory(pharmacy.id),
    getIncomingUnits(pharmacy.id),
    getReorderSettings(pharmacy.id),
    getDailyDemand(pharmacy.id, from, to),
    getMedicines({ activeOnly: false }),
  ]);
  const medicineById = new Map(medicines.map((m) => [m.id, m]));

  const days = new Map();
  for (const row of demandRows) {
    if (!days.has(row.medicine_id)) days.set(row.medicine_id, []);
    days.get(row.medicine_id).push({ date: row.day, sold: row.quantity_sold, closingOnHand: row.closing_on_hand });
  }
  const rowsByMedicine = new Map();
  for (const row of inventory) {
    if (!rowsByMedicine.has(row.medicine_id)) rowsByMedicine.set(row.medicine_id, []);
    rowsByMedicine.get(row.medicine_id).push(row);
  }

  const products = [...rowsByMedicine.entries()].map(([medicineId, rows]) => ({
    medicineId,
    medicine: medicineById.get(medicineId),
    rows,
    days: (days.get(medicineId) ?? []).sort((a, b) => (a.date < b.date ? -1 : 1)),
    stock: stockOf(rows, todayISO),
    incoming: incoming.get(medicineId) ?? 0,
    settings: resolveSettings(pharmacy, settings.get(medicineId)),
  }));
  return { today: todayISO, from, to, inventory, products };
}

// Burn rate, stock cover, Q*, risks for one product from its estimate.
function analyzeProduct(p, estimate, todayISO) {
  const { settings, stock, medicine } = p;
  const burn = estimate.burn;
  const unitsPerPack = medicine?.units_per_pack ?? 1;
  const reorder = computeReorder({
    forecast: estimate.forecast,
    demandSd: estimate.residualSd,
    leadTimeDays: settings.leadTimeDays,
    reviewPeriodDays: settings.reviewPeriodDays,
    safety: settings.safety,
    onHandUsable: stock.onHandUsable,
    reserved: stock.reserved,
    incoming: p.incoming,
    unitsPerPack,
    minOrderPacks: settings.minOrderPacks,
    maxStockUnits: settings.maxStockUnits,
  });
  const cover = stockCover(stock.available, burn);
  const stockout = depletion(stock.available, estimate.forecast, todayISO);
  const positionCover = depletion(reorder.inventoryPosition, estimate.forecast, todayISO).daysOfCover;
  return {
    burn,
    reorder,
    cover,
    projectedStockoutDate: cover.status === "ok" || cover.status === "out_of_stock" ? stockout.stockoutDate : null,
    risk: stockoutRisk({ positionCover, leadTimeDays: settings.leadTimeDays, reviewPeriodDays: settings.reviewPeriodDays }),
    expiry: expiryRisk(stock.batches, estimate.forecast, todayISO),
    unitsPerPack,
    provisional: burn.status === "no_history" || burn.status === "insufficient_history",
  };
}

function estimatesFor(products, windowDays) {
  const provider = getProvider();
  const results = provider.forecast({
    series: products.map((p) => ({ id: p.medicineId, days: p.days })),
    horizonDays: HORIZON_DAYS,
    windowDays,
  });
  return { provider, byId: new Map(results.map((r) => [r.id, r])) };
}

// Share of the history's sales that are synthetic seed data.
async function syntheticShare(pharmacyId, from) {
  const count = async (source) => {
    const { count: n, error } = await supabase
      .from("sales")
      .select("id", { count: "exact", head: true })
      .eq("pharmacy_id", pharmacyId)
      .eq("source", source)
      .gte("sold_at", `${from}T00:00:00Z`);
    if (error) throw error;
    return n ?? 0;
  };
  const [synthetic, pos] = await Promise.all([count("synthetic_seed"), count("pos")]);
  const total = synthetic + pos;
  return { synthetic, pos, share: total === 0 ? 0 : synthetic / total };
}

async function runForecast(pharmacy, userId = null) {
  const todayISO = today();
  const windowDays = pharmacy.burn_rate_window_days;
  const run = unwrap(
    await supabase
      .from("pharmacy_forecast_runs")
      .insert({
        pharmacy_id: pharmacy.id,
        engine: "moving_average",
        horizon_days: HORIZON_DAYS,
        test_days: BACKTEST_DAYS,
        history_start: addDays(todayISO, -HISTORY_DAYS),
        history_end: addDays(todayISO, -1),
        triggered_by: userId,
      })
      .select("id")
      .single()
  );

  try {
    const state = await loadState(pharmacy);
    const { provider, byId } = estimatesFor(state.products, windowDays);

    const forecastRows = [];
    const recommendationRows = [];
    const evaluation = [];
    for (const p of state.products) {
      const estimate = byId.get(p.medicineId);
      const a = analyzeProduct(p, estimate, todayISO);
      const backtest = backtestMovingAverage(p.days, { window: windowDays, testDays: BACKTEST_DAYS });
      const { settings, stock, medicine } = p;

      estimate.forecast.forEach((value, day) =>
        forecastRows.push({
          run_id: run.id,
          pharmacy_id: pharmacy.id,
          medicine_id: p.medicineId,
          forecast_date: addDays(todayISO, day),
          predicted_quantity: round(value, 3),
          model_name: estimate.model,
          is_provisional: a.provisional,
        })
      );

      evaluation.push({
        medicine_id: p.medicineId,
        medicine_name: medicine?.name ?? null,
        model: estimate.model,
        burn_status: a.burn.status,
        window_days: windowDays,
        days_used: a.burn.daysUsed,
        total_sold: a.burn.totalSold,
        stockout_days: a.burn.stockoutDays,
        backtest: backtest.sufficient
          ? { days: backtest.points.length, mae: round(backtest.mae, 3), rmse: round(backtest.rmse, 3), bias: round(backtest.bias, 3) }
          : null,
      });

      if (!settings.isActive) continue;
      const { reorder } = a;
      recommendationRows.push({
        run_id: run.id,
        medicine_id: p.medicineId,
        model_name: estimate.model,
        is_provisional: a.provisional,
        burn_rate: round(a.burn.rate, 3),
        forecast_daily_demand: round(reorder.dailyDemand, 3),
        lead_time_days: settings.leadTimeDays,
        review_period_days: settings.reviewPeriodDays,
        lead_time_demand: round(reorder.leadTimeDemand),
        review_period_demand: round(reorder.reviewPeriodDemand),
        safety_stock: round(reorder.safetyStock),
        reorder_point: round(reorder.reorderPoint),
        target_stock: round(reorder.targetStock),
        on_hand_usable: stock.onHandUsable,
        reserved: stock.reserved,
        incoming: p.incoming,
        inventory_position: round(reorder.inventoryPosition),
        days_of_cover: round(a.cover.days, 1),
        projected_stockout_date: a.projectedStockoutDate,
        stockout_risk: a.risk,
        expiry_risk_units: a.expiry.units,
        needs_reorder: reorder.needsReorder,
        raw_quantity: round(reorder.rawQuantity),
        recommended_units: reorder.recommendedUnits,
        recommended_packs: reorder.recommendedPacks,
        constraints_applied: reorder.constraints,
        explanation: explain({
          result: reorder,
          unitLabel: unitLabelOf(medicine),
          packLabel: `${medicine?.unit ?? "pack"}(s)`,
          windowDays,
          leadTimeDays: settings.leadTimeDays,
          reviewPeriodDays: settings.reviewPeriodDays,
          onHandUsable: stock.onHandUsable,
          incoming: p.incoming,
          reserved: stock.reserved,
        }),
        assumptions: {
          policy: "rule-based order-up-to: Q* = max(0, target stock - inventory position); not EOQ",
          demand_estimate: `moving average of the last ${windowDays} days`,
          burn_rate_status: a.burn.status,
          burn_rate_days_used: a.burn.daysUsed,
          stockout_days_in_window: a.burn.stockoutDays,
          stock_cover_status: a.cover.status,
          safety_stock: reorder.safety.description,
          demand_sd: round(estimate.residualSd, 3),
          units_per_pack: a.unitsPerPack,
          min_order_packs: settings.minOrderPacks,
          max_stock_units: settings.maxStockUnits,
          incoming_definition: "in-transit shipments + submitted orders not yet dispatched",
          usable_definition: "active, unexpired batches minus units held by discrepancy reports; disputed shipment items are never in stock",
          engine: provider.engine,
        },
      });
    }

    for (let i = 0; i < forecastRows.length; i += 500) {
      unwrap(await supabase.from("pharmacy_demand_forecasts").insert(forecastRows.slice(i, i + 500)));
    }
    if (recommendationRows.length > 0) {
      await rpc("pharmacy_publish_recommendations", { p_pharmacy_id: pharmacy.id, p_rows: recommendationRows });
    }

    const synthetic = await syntheticShare(pharmacy.id, addDays(todayISO, -windowDays));
    const summary = {
      products: state.products.length,
      window_days: windowDays,
      insufficient_history: evaluation.filter((e) => e.burn_status === "insufficient_history" || e.burn_status === "no_history").length,
      recommendations: recommendationRows.length,
      order_now: recommendationRows.filter((r) => r.needs_reorder).length,
      with_quantity: recommendationRows.filter((r) => r.recommended_packs > 0).length,
      synthetic_sales: synthetic.synthetic,
      pos_sales: synthetic.pos,
    };
    const dataNote =
      synthetic.share > 0
        ? `${Math.round(synthetic.share * 100)}% of the sales in the ${windowDays}-day window are synthetic seed data (sales.source = 'synthetic_seed'), not real transactions.`
        : null;

    const finished = unwrap(
      await supabase
        .from("pharmacy_forecast_runs")
        .update({
          status: "completed",
          product_count: state.products.length,
          evaluation,
          summary,
          data_note: dataNote,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .select("*")
        .single()
    );
    await refreshAlerts(pharmacy);
    return finished;
  } catch (error) {
    await supabase
      .from("pharmacy_forecast_runs")
      .update({ status: "failed", error_message: String(error.message).slice(0, 1000), finished_at: new Date().toISOString() })
      .eq("id", run.id);
    throw error;
  }
}

// Recomputes which alerts should be open from the current stock and the
// moving average, and syncs pharmacy_alerts: new conditions are inserted,
// existing ones updated (keeping acknowledged status), cleared ones resolved.
async function refreshAlerts(pharmacy) {
  const state = await loadState(pharmacy, Math.max(pharmacy.burn_rate_window_days, 42));
  const { byId } = estimatesFor(state.products, pharmacy.burn_rate_window_days);

  const products = [];
  const batches = [];
  for (const p of state.products) {
    const a = analyzeProduct(p, byId.get(p.medicineId), state.today);
    const riskByBatch = new Map(a.expiry.batches.map((b) => [b.batchId, b.units]));
    const hadSales = p.days.some((day) => day.sold > 0);
    const packLabel = `${p.medicine?.unit ?? "pack"}(s)`;

    products.push({
      medicineId: p.medicineId,
      name: p.medicine?.name ?? "Product",
      unitLabel: unitLabelOf(p.medicine),
      available: p.stock.available,
      // Stock-level alerts only for products that are actually sold or ordered here.
      tracked: p.stock.available > 0 || hadSales || p.incoming > 0,
      // Default low-stock threshold: the safety stock (reorder alerts cover the reorder point).
      lowStockThreshold: p.settings.lowStockThreshold ?? (a.reorder.safetyStock > 0 ? Math.ceil(a.reorder.safetyStock) : null),
      recommendation: p.settings.isActive
        ? {
            needsReorder: a.reorder.needsReorder,
            recommendedPacks: a.reorder.recommendedPacks,
            packLabel,
            leadTimeDays: p.settings.leadTimeDays,
            daysOfCover: a.cover.days,
            projectedStockoutDate: a.projectedStockoutDate,
            incoming: p.incoming,
            inventoryPosition: a.reorder.inventoryPosition,
            reorderPoint: a.reorder.reorderPoint,
          }
        : null,
      consumption: consumptionChange(p.days),
      recentStockout: p.days.slice(-14).some((day) => day.closingOnHand === 0),
    });

    for (const row of p.rows) {
      const available = row.quantity_on_hand - row.quantity_reserved;
      if (available <= 0) continue;
      batches.push({
        batchId: row.batch_id,
        medicineId: p.medicineId,
        name: p.medicine?.name ?? "Product",
        batchNumber: row.batch_number,
        expiryDate: row.expiry_date,
        daysToExpiry: daysBetween(state.today, row.expiry_date),
        available,
        expiryRiskUnits: riskByBatch.get(row.batch_id) ?? null,
      });
    }
  }

  const wanted = buildAlerts({ products, batches, nearExpiryDays: pharmacy.near_expiry_days });
  const active = unwrap(
    await supabase.from("pharmacy_alerts").select("id, dedupe_key, status").eq("pharmacy_id", pharmacy.id).neq("status", "resolved")
  );
  const activeByKey = new Map(active.map((row) => [row.dedupe_key, row]));
  const wantedKeys = new Set(wanted.map((alert) => alert.dedupe_key));

  for (const alert of wanted) {
    const existing = activeByKey.get(alert.dedupe_key);
    const fields = {
      alert_type: alert.alert_type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      details: alert.details,
      medicine_id: alert.medicine_id ?? null,
      batch_id: alert.batch_id ?? null,
    };
    if (existing) {
      unwrap(await supabase.from("pharmacy_alerts").update(fields).eq("id", existing.id));
    } else {
      const { error } = await supabase.from("pharmacy_alerts").insert({ ...fields, pharmacy_id: pharmacy.id, dedupe_key: alert.dedupe_key });
      // A concurrent refresh inserted the same alert first.
      if (error && error.code !== "23505") unwrap({ error });
    }
  }
  const cleared = active.filter((row) => !wantedKeys.has(row.dedupe_key)).map((row) => row.id);
  if (cleared.length > 0) {
    unwrap(
      await supabase.from("pharmacy_alerts").update({ status: "resolved", resolved_at: new Date().toISOString() }).in("id", cleared)
    );
  }
  return { open: wanted.length, resolved: cleared.length };
}

// Alerts after a stock change; failures are logged, not returned to the user
// (the stock change itself has already succeeded).
async function refreshAlertsQuietly(pharmacyOrId) {
  try {
    let pharmacy = pharmacyOrId;
    if (typeof pharmacyOrId === "string") {
      const { PHARMACY_SELECT } = require("../auth");
      pharmacy = unwrap(await supabase.from("pharmacies").select(PHARMACY_SELECT).eq("id", pharmacyOrId).single());
    }
    await refreshAlerts(pharmacy);
  } catch (error) {
    console.error(`[pharmacy] alert refresh failed: ${error.message}`);
  }
}

module.exports = {
  HISTORY_DAYS,
  HORIZON_DAYS,
  BACKTEST_DAYS,
  loadState,
  resolveSettings,
  stockOf,
  analyzeProduct,
  estimatesFor,
  runForecast,
  refreshAlerts,
  refreshAlertsQuietly,
  unitLabelOf,
};
