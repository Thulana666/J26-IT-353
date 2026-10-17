// Alert rules: which alerts should be open right now. Pure function; the
// alert service stores the result (one active alert per dedupe key).
//
//   low_stock            available stock at or below the threshold (critical when out)
//   reorder              inventory position at or below the reorder point (critical when
//                        the stock will not last the lead time)
//   near_expiry          unreserved stock expiring within the pharmacy's threshold
//   expired              unreserved stock past its expiry date (return or dispose)
//   unusual_consumption  last 7 days far above (or below) the previous 28 days

const { round } = require("./stats");
const { CRITICAL_EXPIRY_DAYS } = require("../dates");

const SPIKE_RATIO = 1.6;
const SPIKE_Z = 2.5;
const DROP_RATIO = 0.4;

const fmt = (value, digits = 1) => round(value, digits)?.toLocaleString("en-US");

// products: [{ medicineId, name, unitLabel, available, tracked?, lowStockThreshold,
//              recommendation?: { needsReorder, recommendedPacks, packLabel, leadTimeDays, daysOfCover,
//                                 projectedStockoutDate, incoming, inventoryPosition, reorderPoint },
//              consumption?: { recentDaily, baselineDaily, ratio, z }, recentStockout }]
// batches:  [{ batchId, medicineId, name, batchNumber, expiryDate, daysToExpiry, available }]
function buildAlerts({ products, batches, nearExpiryDays }) {
  const alerts = [];
  const add = (alert) => alerts.push({ details: {}, batch_id: null, ...alert });

  for (const p of products) {
    if (p.tracked === false) {
      // Not sold or ordered here recently: no stock-level alerts.
    } else if (p.available <= 0) {
      add({
        dedupe_key: `low_stock:${p.medicineId}`,
        alert_type: "low_stock",
        severity: "critical",
        medicine_id: p.medicineId,
        title: `${p.name} is out of stock`,
        message: `No sellable ${p.unitLabel} left.${p.recommendation?.incoming ? ` ${p.recommendation.incoming} units are on the way.` : ""}`,
        details: { available: p.available, threshold: p.lowStockThreshold },
      });
    } else if (p.lowStockThreshold !== null && p.available <= p.lowStockThreshold) {
      add({
        dedupe_key: `low_stock:${p.medicineId}`,
        alert_type: "low_stock",
        severity: "warning",
        medicine_id: p.medicineId,
        title: `${p.name} is low`,
        message: `${p.available} ${p.unitLabel} available, at or below the threshold of ${Math.round(p.lowStockThreshold)}.`,
        details: { available: p.available, threshold: p.lowStockThreshold },
      });
    }

    const rec = p.recommendation;
    if (p.tracked !== false && rec?.needsReorder) {
      const late = rec.daysOfCover !== null && rec.daysOfCover < rec.leadTimeDays;
      add({
        dedupe_key: `reorder:${p.medicineId}`,
        alert_type: "reorder",
        severity: late ? "critical" : "warning",
        medicine_id: p.medicineId,
        title: `Reorder ${p.name}${rec.recommendedPacks > 0 ? `: ${rec.recommendedPacks} ${rec.packLabel}` : ""}`,
        message:
          `Inventory position ${fmt(rec.inventoryPosition, 0)} is at or below the reorder point ${fmt(rec.reorderPoint, 0)}.` +
          (rec.daysOfCover === null ? "" : ` About ${fmt(rec.daysOfCover)} days of stock at the current burn rate; lead time ${rec.leadTimeDays} days.`) +
          (late ? " Stock may run out before an order placed today arrives." : ""),
        details: {
          inventoryPosition: rec.inventoryPosition,
          reorderPoint: rec.reorderPoint,
          recommendedPacks: rec.recommendedPacks,
          daysOfCover: rec.daysOfCover,
          stockoutDate: rec.projectedStockoutDate,
        },
      });
    }

    const c = p.consumption;
    if (c && c.ratio !== null) {
      if (c.ratio >= SPIKE_RATIO && c.recentDaily >= 1 && (c.z === null || c.z >= SPIKE_Z)) {
        add({
          dedupe_key: `unusual_consumption:${p.medicineId}`,
          alert_type: "unusual_consumption",
          severity: "warning",
          medicine_id: p.medicineId,
          title: `${p.name}: consumption ${fmt(c.ratio)}x usual`,
          message: `${fmt(c.recentDaily)} ${p.unitLabel}/day over the last 7 days vs ${fmt(c.baselineDaily)}/day before. Check for an outbreak, a bulk buyer or a recording error.`,
          details: c,
        });
      } else if (c.ratio <= DROP_RATIO && c.baselineDaily >= 2 && !p.recentStockout) {
        add({
          dedupe_key: `unusual_consumption:${p.medicineId}`,
          alert_type: "unusual_consumption",
          severity: "info",
          medicine_id: p.medicineId,
          title: `${p.name}: consumption dropped to ${fmt(c.ratio * 100, 0)}% of usual`,
          message: `${fmt(c.recentDaily)} ${p.unitLabel}/day over the last 7 days vs ${fmt(c.baselineDaily)}/day before.`,
          details: c,
        });
      }
    }
  }

  for (const b of batches) {
    if (b.available <= 0) continue;
    if (b.daysToExpiry < 0) {
      add({
        dedupe_key: `expired:${b.batchId}`,
        alert_type: "expired",
        severity: "critical",
        medicine_id: b.medicineId,
        batch_id: b.batchId,
        title: `${b.name} batch ${b.batchNumber} has expired`,
        message: `${b.available} units expired on ${b.expiryDate}. They cannot be sold; return them to the warehouse.`,
        details: { available: b.available, expiryDate: b.expiryDate },
      });
    } else if (b.daysToExpiry <= nearExpiryDays) {
      add({
        dedupe_key: `near_expiry:${b.batchId}`,
        alert_type: "near_expiry",
        severity: b.daysToExpiry <= CRITICAL_EXPIRY_DAYS ? "critical" : "warning",
        medicine_id: b.medicineId,
        batch_id: b.batchId,
        title: `${b.name} batch ${b.batchNumber} expires in ${b.daysToExpiry} days`,
        message: `${b.available} units expire on ${b.expiryDate}.${b.expiryRiskUnits ? ` About ${b.expiryRiskUnits} may not sell in time at the forecast rate.` : ""}`,
        details: { available: b.available, expiryDate: b.expiryDate, daysToExpiry: b.daysToExpiry, expiryRiskUnits: b.expiryRiskUnits ?? null },
      });
    }
  }
  return alerts;
}

module.exports = { buildAlerts, SPIKE_RATIO, SPIKE_Z, DROP_RATIO };
