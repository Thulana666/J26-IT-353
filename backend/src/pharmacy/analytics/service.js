// Demand estimates, reorder recommendations and alerts for one pharmacy.
//
// runForecast():
//   1. daily units sold per product from the pharmacy's own sale items, with
//      the closing stock of each day from the stock ledger
//      (pharmacy_daily_demand()),
//   2. trains the pooled linear-regression demand model (linear-regression.js)
//      and evaluates it against the moving average on held-out days; each
//      product uses the regression only where it was more accurate, otherwise
//      the moving average (forecast-provider.js),
//   3. burn rate, stock cover, Q*, stockout and expiry risk per product, and an
//      actual-versus-estimated backtest of the moving average,
//   4. stores the run, the estimates and the recommendations, then refreshes
//      alerts. Re-running it after new sales and receipts updates everything.

const { supabase, today, addDays, rpc, getInventory, getOrderedUnits, getDailyDemand, getReorderSettings, getMedicines } = require("../store");
const { unwrap } = require("../errors");
const { daysBetween } = require("../dates");
const { round } = require("./stats");
const { FEATURES, LOOKBACK, evaluateHoldout, fitRidge } = require("./linear-regression");
const { getProvider } = require("./forecast-provider");
const { backtestMovingAverage, consumptionChange } = require("./demand");
const { computeReorder, explain } = require("./reorder");
const { depletion, stockCover, stockoutRisk, expiryRisk } = require("./depletion");
const { buildAlerts } = require("./alert-rules");

const HISTORY_DAYS = Number(process.env.PHARMACY_HISTORY_DAYS) || 180;
const HORIZON_DAYS = 30;
const BACKTEST_DAYS = 28;

// Demand model training. Real POS history is used once it covers at least
// MIN_REAL_HISTORY_DAYS; until then the model is trained on the labelled sample
// history (sales.source = 'synthetic_seed') as a demonstration of the method.
const MIN_REAL_HISTORY_DAYS = 90;
const MODEL_TEST_DAYS = 28;
const MODEL_LAMBDA = 1;
// Held-out days a product needs before its own comparison selects the model.
const MIN_SELECT_OBSERVATIONS = 14;

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
  const [inventory, ordered, settings, demandRows, medicines] = await Promise.all([
    getInventory(pharmacy.id),
    getOrderedUnits(pharmacy.id),
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
    // Confirmed incoming (in transit or accepted by the warehouse); counted in the position.
    incoming: ordered.incoming.get(medicineId) ?? 0,
    // Ordered but not yet accepted by the warehouse; reported, not counted.
    awaiting: ordered.awaiting.get(medicineId) ?? 0,
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
  // Stock cover uses the forecast daily demand, the same demand Q* uses.
  const cover = stockCover(stock.available, burn.rate === null ? burn : { ...burn, rate: reorder.dailyDemand });
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
    reason: replenishmentReason({ reorder, cover }, p, unitLabelOf(medicine)),
  };
}

// One-line explanation of the recommendation, shown with Q*.
function replenishmentReason({ reorder, cover }, p, units) {
  const n = (value) => Math.round(value).toLocaleString("en-US");
  const awaiting = p.awaiting > 0 ? ` ${n(p.awaiting)} ${units} ordered are awaiting warehouse acceptance and are not counted.` : "";
  if (!(reorder.dailyDemand > 0)) return `No recent demand, so nothing to reorder.${awaiting}`;
  if (reorder.needsReorder) {
    return `Reorder: inventory position ${n(reorder.inventoryPosition)} ${units} is at or below the reorder point ${n(reorder.reorderPoint)} (lead-time demand + safety stock).${awaiting}`;
  }
  if (cover.status === "out_of_stock" && p.incoming > 0) {
    return `Out of stock now, but ${n(p.incoming)} ${units} on the way keep the position above the reorder point ${n(reorder.reorderPoint)}.${awaiting}`;
  }
  return `No order needed: inventory position ${n(reorder.inventoryPosition)} ${units} is above the reorder point ${n(reorder.reorderPoint)}.${awaiting}`;
}

// model: a trained model (summary.model of a run) or null for the moving average.
function estimatesFor(products, windowDays, model = null) {
  const provider = getProvider(model);
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

// First and last local sale dates of one data source, or null.
async function saleDateRange(pharmacyId, source) {
  const edge = (ascending) =>
    supabase
      .from("sales")
      .select("sold_at")
      .eq("pharmacy_id", pharmacyId)
      .eq("source", source)
      .order("sold_at", { ascending })
      .limit(1)
      .maybeSingle()
      .then(unwrap);
  const [first, last] = await Promise.all([edge(true), edge(false)]);
  return first ? { from: today(new Date(first.sold_at)), to: today(new Date(last.sold_at)) } : null;
}

// Which history the model is trained on (see MIN_REAL_HISTORY_DAYS).
async function trainingPeriod(pharmacyId) {
  const yesterday = addDays(today(), -1);
  const [pos, sample] = await Promise.all([saleDateRange(pharmacyId, "pos"), saleDateRange(pharmacyId, "synthetic_seed")]);
  if (pos && daysBetween(pos.from, yesterday) + 1 >= MIN_REAL_HISTORY_DAYS) return { source: "pos", from: pos.from, to: yesterday };
  if (sample) return { source: "synthetic_seed", from: sample.from, to: sample.to };
  return null;
}

const roundMetrics = (m) => ({ mae: round(m.mae, 3), rmse: round(m.rmse, 3) });

// Trains and evaluates the demand model for one pharmacy. Read-only.
// -> { status: "trained", model } | { status, reason, period }
async function trainDemandModel(pharmacy) {
  const period = await trainingPeriod(pharmacy.id);
  if (!period) return { status: "no_history", reason: "No sales history to train on." };
  const rows = await getDailyDemand(pharmacy.id, period.from, period.to);
  const byMedicine = new Map();
  for (const row of rows) {
    if (!byMedicine.has(row.medicine_id)) byMedicine.set(row.medicine_id, []);
    byMedicine.get(row.medicine_id).push({ date: row.day, sold: row.quantity_sold, closingOnHand: row.closing_on_hand });
  }
  const series = [...byMedicine.entries()].map(([id, days]) => ({ id, days: days.sort((a, b) => (a.date < b.date ? -1 : 1)) }));
  const holdout = evaluateHoldout(series, { testDays: MODEL_TEST_DAYS, lambda: MODEL_LAMBDA });
  if (!holdout) {
    return { status: "insufficient_history", reason: `Not enough history from ${period.from} to ${period.to} for a ${MODEL_TEST_DAYS}-day holdout.`, period };
  }
  const perProduct = {};
  for (const [id, s] of Object.entries(holdout.perSeries)) {
    perProduct[id] = {
      observations: s.observations,
      linearRegression: roundMetrics(s.linearRegression),
      movingAverage: roundMetrics(s.movingAverage),
      residualSd: round(s.residualSd, 3),
      // The regression is used for this product only if it beat the baseline here.
      selected: s.observations >= MIN_SELECT_OBSERVATIONS && s.linearRegression.mae < s.movingAverage.mae,
    };
  }
  return {
    status: "trained",
    model: {
      method: "linear_regression",
      version: 1,
      units: "dispensing units per day",
      features: FEATURES,
      // Refitted on every row (training + held-out days) after the evaluation.
      coefficients: fitRidge(holdout.allRows, MODEL_LAMBDA),
      lambda: MODEL_LAMBDA,
      lookbackDays: LOOKBACK,
      trainedAt: new Date().toISOString(),
      trainedOn: { source: period.source, sample: period.source === "synthetic_seed", from: period.from, to: period.to, rows: holdout.allRows.length },
      train: holdout.train,
      test: holdout.test,
      metrics: { linearRegression: roundMetrics(holdout.overall.linearRegression), movingAverage: roundMetrics(holdout.overall.movingAverage) },
      perProduct,
    },
  };
}

// The model of the latest completed recalculation, or null (moving average).
async function getActiveModel(pharmacyId) {
  const run = unwrap(
    await supabase
      .from("pharmacy_forecast_runs")
      .select("engine, summary")
      .eq("pharmacy_id", pharmacyId)
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  return run?.engine === "linear_regression" ? (run.summary?.model ?? null) : null;
}

async function runForecast(pharmacy, userId = null) {
  const todayISO = today();
  const windowDays = pharmacy.burn_rate_window_days;
  let training;
  try {
    training = await trainDemandModel(pharmacy);
  } catch (error) {
    training = { status: "failed", reason: String(error.message).slice(0, 300) };
  }
  let model = training.status === "trained" ? training.model : null;
  const insertRun = (engine) =>
    supabase
      .from("pharmacy_forecast_runs")
      .insert({
        pharmacy_id: pharmacy.id,
        engine,
        horizon_days: HORIZON_DAYS,
        test_days: BACKTEST_DAYS,
        history_start: addDays(todayISO, -HISTORY_DAYS),
        history_end: addDays(todayISO, -1),
        triggered_by: userId,
      })
      .select("id")
      .single();
  let inserted = await insertRun(model ? "linear_regression" : "moving_average");
  // Database without 20261020000000: keep working with the moving average.
  const migrationMissing = Boolean(model) && inserted.error?.code === "23514";
  if (migrationMissing) {
    model = null;
    inserted = await insertRun("moving_average");
  }
  const run = unwrap(inserted);

  try {
    const state = await loadState(pharmacy);
    const { provider, byId } = estimatesFor(state.products, windowDays, model);

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
        model_evaluation: model?.perProduct?.[p.medicineId] ?? null,
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
          demand_estimate:
            estimate.model === "linear_regression"
              ? "pooled linear regression (previous day, same day last week, 7-day mean, day of week), forecast day by day"
              : `moving average of the last ${windowDays} days`,
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
      model_products: [...byId.values()].filter((e) => e.model === "linear_regression").length,
      training: { status: training.status, reason: training.reason ?? null, period: training.period ?? null, migration_missing: migrationMissing },
      model,
    };
    const notes = [];
    if (synthetic.share > 0) {
      notes.push(`${Math.round(synthetic.share * 100)}% of the sales in the ${windowDays}-day window are synthetic seed data (sales.source = 'synthetic_seed'), not real transactions.`);
    }
    if (model?.trainedOn.sample) {
      notes.push(`The linear regression was trained and evaluated on sample (synthetic) history from ${model.trainedOn.from} to ${model.trainedOn.to}: a demonstration of the method, not real-world accuracy.`);
    }
    if (migrationMissing) notes.push("Linear regression not used: apply supabase/migrations/20261020000000_pharmacy_linear_regression_model.sql.");
    const dataNote = notes.join(" ") || null;

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
  const [state, model] = await Promise.all([loadState(pharmacy, Math.max(pharmacy.burn_rate_window_days, 42)), getActiveModel(pharmacy.id)]);
  const { byId } = estimatesFor(state.products, pharmacy.burn_rate_window_days, model);

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
  trainDemandModel,
  getActiveModel,
  replenishmentReason,
  runForecast,
  refreshAlerts,
  refreshAlertsQuietly,
  unitLabelOf,
};
