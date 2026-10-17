// GET /api/pharmacy/dashboard - headline figures for the current pharmacy.

const express = require("express");
const { supabase, today, addDays, getInventory, fetchAll } = require("../store");
const { unwrap } = require("../errors");
const { requirePharmacyStaff, pharmacyScope } = require("../auth");
const { toPharmacy, toAlert, toRecommendation, money } = require("../mappers");
const { daysBetween } = require("../dates");
const { round } = require("../analytics/stats");
const { PRODUCT } = require("./common");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

// Start of a local (Asia/Colombo) day as an ISO timestamp.
const dayStart = (iso) => `${iso}T00:00:00+05:30`;

router.get("/", async (req, res) => {
  const pharmacy = req.pharmacy;
  const todayISO = today();
  const since = addDays(todayISO, -13);
  const count = async (table, build) => {
    const { count: n, error } = await build(supabase.from(table).select("id", { count: "exact", head: true }).eq("pharmacy_id", pharmacy.id));
    if (error) unwrap({ error });
    return n ?? 0;
  };

  const [inventory, recentSales, alerts, recommendations, pendingShipments, openDiscrepancies, pendingReturns, latestRun, heldItems] =
    await Promise.all([
      getInventory(pharmacy.id),
      fetchAll(() =>
        supabase
          .from("sales")
          .select("id, sale_number, total_amount, source, sold_at")
          .eq("pharmacy_id", pharmacy.id)
          .gte("sold_at", dayStart(since))
          .order("sold_at", { ascending: false })
      ),
      supabase
        .from("pharmacy_alerts")
        .select("*, medicine:medicines(name, strength), batch:batches(batch_number)")
        .eq("pharmacy_id", pharmacy.id)
        .neq("status", "resolved")
        .order("created_at", { ascending: false })
        .then(unwrap),
      supabase
        .from("reorder_recommendations")
        .select(`*, ${PRODUCT}`)
        .eq("pharmacy_id", pharmacy.id)
        .eq("status", "pending")
        .eq("needs_reorder", true)
        .gt("recommended_packs", 0)
        .order("stockout_risk")
        .then(unwrap),
      count("shipments", (q) => q.eq("status", "in_transit")),
      count("shipment_discrepancies", (q) => q.neq("status", "resolved")),
      count("return_requests", (q) => q.in("status", ["pending", "approved"])),
      supabase
        .from("pharmacy_forecast_runs")
        .select("id, status, engine, finished_at, data_note, summary")
        .eq("pharmacy_id", pharmacy.id)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(unwrap),
      // Disputed shipment items held out of stock until resolved and accepted.
      count("shipment_items", (q) => q.eq("verification_status", "discrepancy").is("quantity_accepted", null)),
    ]);

  const usable = inventory.filter((row) => row.batch_status === "active" && row.expiry_date >= todayISO);
  const productsInStock = new Set(usable.filter((row) => row.quantity_available > 0).map((row) => row.medicine_id));
  const heldUnits = inventory.reduce((total, row) => total + (row.quantity_held ?? 0), 0);
  const stockValue = inventory.reduce((total, row) => total + row.quantity_on_hand * Number(row.unit_cost ?? 0), 0);
  const withStock = inventory.filter((row) => row.quantity_on_hand - row.quantity_reserved > 0);
  const nearExpiry = withStock.filter((row) => {
    const d = daysBetween(todayISO, row.expiry_date);
    return d >= 0 && d <= pharmacy.near_expiry_days;
  });
  const expired = withStock.filter((row) => row.expiry_date < todayISO);

  // Daily sales for the last 14 days (local dates).
  const localDay = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date(ts));
  const daily = Array.from({ length: 14 }, (_, i) => ({ date: addDays(since, i), revenue: 0, bills: 0, synthetic: 0 }));
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const sale of recentSales) {
    const d = byDate.get(localDay(sale.sold_at));
    if (!d) continue;
    d.revenue += Number(sale.total_amount);
    d.bills += 1;
    if (sale.source === "synthetic_seed") d.synthetic += 1;
  }
  const todays = byDate.get(todayISO);
  const priority = { critical: 0, warning: 1, info: 2 };
  const riskOrder = { high: 0, medium: 1, low: 2, none: 3 };

  res.json({
    pharmacy: toPharmacy(pharmacy),
    today: todayISO,
    figures: {
      productsInStock: productsInStock.size,
      productsStocked: new Set(inventory.map((row) => row.medicine_id)).size,
      stockValue: round(stockValue, 2),
      lowStockItems: alerts.filter((a) => a.alert_type === "low_stock").length,
      outOfStockItems: alerts.filter((a) => a.alert_type === "low_stock" && a.severity === "critical").length,
      nearExpiryBatches: nearExpiry.length,
      nearExpiryUnits: nearExpiry.reduce((t, row) => t + row.quantity_on_hand - row.quantity_reserved, 0),
      expiredBatches: expired.length,
      pendingShipments,
      heldItems,
      heldUnits,
      openDiscrepancies,
      pendingReturns,
      todaySales: { bills: todays.bills, revenue: round(todays.revenue, 2) },
      reorderRecommendations: recommendations.length,
      openAlerts: { total: alerts.length, critical: alerts.filter((a) => a.severity === "critical").length },
    },
    salesTrend: daily.map((d) => ({ ...d, revenue: round(d.revenue, 2) })),
    alerts: alerts
      .sort((a, b) => priority[a.severity] - priority[b.severity])
      .slice(0, 6)
      .map(toAlert),
    recommendations: recommendations
      .sort((a, b) => riskOrder[a.stockout_risk] - riskOrder[b.stockout_risk])
      .slice(0, 6)
      .map((row) => toRecommendation(row)),
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          engine: latestRun.engine,
          finishedAt: latestRun.finished_at,
          dataNote: latestRun.data_note,
          summary: latestRun.summary,
        }
      : null,
    recentSales: recentSales.slice(0, 5).map((s) => ({
      id: s.id,
      saleNumber: s.sale_number,
      totalAmount: money(s.total_amount),
      source: s.source,
      soldAt: s.sold_at,
    })),
  });
});

module.exports = router;
