// /api/pharmacy/analytics - pharmacy-specific demand analytics (moving average).
//
// GET  /                      per product: burn rate, usable/incoming stock, stock cover, current Q*
// GET  /products/:medicineId  daily sales history, actual vs estimated demand, estimate, Q* breakdown
// POST /run                   recompute estimates, recommendations and alerts now
// GET  /research?days=90      evaluation metrics from recorded data

const express = require("express");
const { supabase, fetchAll } = require("../store");
const { unwrap } = require("../errors");
const { requirePharmacyStaff, pharmacyScope } = require("../auth");
const { parse, z, id, int, optional } = require("../validation");
const { toRecommendation, toProduct } = require("../mappers");
const { loadState, analyzeProduct, estimatesFor, runForecast, unitLabelOf, BACKTEST_DAYS } = require("../analytics/service");
const { backtestMovingAverage, isObserved } = require("../analytics/demand");
const { researchMetrics } = require("../analytics/research");
const { round } = require("../analytics/stats");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

const RUN_SELECT =
  "id, status, engine, history_start, history_end, horizon_days, test_days, product_count, summary, data_note, error_message, started_at, finished_at";

const latestRun = (pharmacyId) =>
  supabase
    .from("pharmacy_forecast_runs")
    .select(RUN_SELECT)
    .eq("pharmacy_id", pharmacyId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .then(unwrap);

const toRun = (run) =>
  run && {
    id: run.id,
    status: run.status,
    engine: run.engine,
    horizonDays: run.horizon_days,
    productCount: run.product_count,
    summary: run.summary,
    dataNote: run.data_note,
    errorMessage: run.error_message,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };

// Latest recommendation per product (pending first, else the most recent).
async function latestRecommendations(pharmacyId) {
  const rows = await fetchAll(() =>
    supabase.from("reorder_recommendations").select("*").eq("pharmacy_id", pharmacyId).order("generated_at", { ascending: false }).order("id")
  );
  const byMedicine = new Map();
  for (const row of rows) {
    const current = byMedicine.get(row.medicine_id);
    if (!current || (current.status !== "pending" && row.status === "pending")) byMedicine.set(row.medicine_id, row);
  }
  return byMedicine;
}

const toBurn = (burn) => ({
  rate: round(burn.rate, 2),
  status: burn.status,
  windowDays: burn.windowDays,
  daysUsed: burn.daysUsed,
  totalSold: burn.totalSold,
  stockoutDays: burn.stockoutDays,
});

const toCover = (cover) => ({ days: round(cover.days, 1), status: cover.status, provisional: cover.provisional });

router.get("/", async (req, res) => {
  const pharmacy = req.pharmacy;
  const [state, recs, run] = await Promise.all([loadState(pharmacy, Math.max(pharmacy.burn_rate_window_days, 30)), latestRecommendations(pharmacy.id), latestRun(pharmacy.id)]);
  const { byId } = estimatesFor(state.products, pharmacy.burn_rate_window_days);
  const products = state.products
    .map((p) => {
      const a = analyzeProduct(p, byId.get(p.medicineId), state.today);
      const rec = recs.get(p.medicineId);
      return {
        product: toProduct(p.medicine),
        unitLabel: unitLabelOf(p.medicine),
        burnRate: toBurn(a.burn),
        stock: { available: p.stock.available, onHandUsable: p.stock.onHandUsable, reserved: p.stock.reserved, incoming: p.incoming },
        stockCover: toCover(a.cover),
        live: {
          inventoryPosition: round(a.reorder.inventoryPosition),
          reorderPoint: round(a.reorder.reorderPoint),
          targetStock: round(a.reorder.targetStock),
          recommendedPacks: a.reorder.recommendedPacks,
          needsReorder: a.reorder.needsReorder,
        },
        last30: p.days.slice(-30).map((d) => d.sold),
        recommendation: rec ? toRecommendation(rec) : null,
      };
    })
    .sort((a, b) => (a.product?.name ?? "").localeCompare(b.product?.name ?? ""));
  res.json({ today: state.today, windowDays: pharmacy.burn_rate_window_days, run: toRun(run), products });
});

const productQuery = z.object({ days: optional(int(14, 365)) });

router.get("/products/:medicineId", async (req, res) => {
  const { medicineId } = parse(z.object({ medicineId: id }), req.params);
  const { days = 90 } = parse(productQuery, req.query);
  const pharmacy = req.pharmacy;
  const windowDays = pharmacy.burn_rate_window_days;
  // Extra history so the first shown day has a full window for its estimate.
  const [state, recs] = await Promise.all([loadState(pharmacy, days + windowDays), latestRecommendations(pharmacy.id)]);
  const product = state.products.find((p) => p.medicineId === medicineId);
  if (!product) {
    return res.json({ today: state.today, product: null, unitLabel: "units", history: [], backtest: null, estimate: null, recommendation: null });
  }
  const { byId } = estimatesFor([product], windowDays);
  const estimate = byId.get(medicineId);
  const a = analyzeProduct(product, estimate, state.today);
  const backtest = backtestMovingAverage(product.days, { window: windowDays, testDays: days });
  const rec = recs.get(medicineId);
  res.json({
    today: state.today,
    windowDays,
    product: toProduct(product.medicine),
    unitLabel: unitLabelOf(product.medicine),
    history: product.days.slice(-days).map((d) => ({ date: d.date, sold: d.sold, closingOnHand: d.closingOnHand, inStock: isObserved(d) })),
    backtest: {
      sufficient: backtest.sufficient,
      days: backtest.points.length,
      mae: round(backtest.mae, 3),
      rmse: round(backtest.rmse, 3),
      bias: round(backtest.bias, 3),
      points: backtest.points.map((p) => ({ date: p.date, actual: p.actual, estimate: round(p.estimate, 3) })),
      recentMae: (() => {
        const recent = backtestMovingAverage(product.days, { window: windowDays, testDays: BACKTEST_DAYS });
        return recent.sufficient ? round(recent.mae, 3) : null;
      })(),
    },
    estimate: { model: estimate.model, daily: round(estimate.level, 3), horizonDays: estimate.forecast.length },
    burnRate: toBurn(a.burn),
    stockCover: toCover(a.cover),
    stock: { ...product.stock, incoming: product.incoming },
    settings: product.settings,
    live: {
      dailyDemand: round(a.reorder.dailyDemand, 3),
      leadTimeDemand: round(a.reorder.leadTimeDemand),
      reviewPeriodDemand: round(a.reorder.reviewPeriodDemand),
      safetyStock: round(a.reorder.safetyStock),
      safetyDescription: a.reorder.safety.description,
      reorderPoint: round(a.reorder.reorderPoint),
      targetStock: round(a.reorder.targetStock),
      inventoryPosition: round(a.reorder.inventoryPosition),
      rawQuantity: round(a.reorder.rawQuantity),
      recommendedPacks: a.reorder.recommendedPacks,
      recommendedUnits: a.reorder.recommendedUnits,
      needsReorder: a.reorder.needsReorder,
      constraints: a.reorder.constraints,
      projectedStockoutDate: a.projectedStockoutDate,
      expiryRiskUnits: a.expiry.units,
    },
    recommendation: rec ? toRecommendation(rec) : null,
  });
});

router.post("/run", async (req, res) => {
  const run = await runForecast(req.pharmacy, req.user.id);
  res.json({ run: toRun(run) });
});

router.get("/research", async (req, res) => {
  const { days = 90 } = parse(z.object({ days: optional(int(14, 365)) }), req.query);
  res.json(await researchMetrics(req.pharmacy, { days }));
});

module.exports = router;
