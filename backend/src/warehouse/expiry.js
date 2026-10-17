// Expiry classification (deterministic business rule).
//
//   expired      expiry date is before today (the expiry date itself is still usable)
//   critical     0..criticalExpiryDays days left
//   near_expiry  up to nearExpiryDays days left
//   ok           more than nearExpiryDays days left
//
// Thresholds are configured per warehouse (warehouses.near_expiry_days /
// critical_expiry_days) and can be overridden per request.

const { daysBetween } = require("./dates");

const EXPIRY_STATUSES = ["expired", "critical", "near_expiry", "ok"];
const DEFAULT_THRESHOLDS = Object.freeze({ nearExpiryDays: 90, criticalExpiryDays: 30 });

function assertThresholds({ nearExpiryDays, criticalExpiryDays }) {
  if (!Number.isInteger(criticalExpiryDays) || criticalExpiryDays <= 0) {
    throw new RangeError("criticalExpiryDays must be a positive whole number");
  }
  if (!Number.isInteger(nearExpiryDays) || nearExpiryDays <= criticalExpiryDays) {
    throw new RangeError("nearExpiryDays must be a whole number greater than criticalExpiryDays");
  }
  return { nearExpiryDays, criticalExpiryDays };
}

function classifyExpiry(expiryDate, today, thresholds = DEFAULT_THRESHOLDS) {
  const { nearExpiryDays, criticalExpiryDays } = thresholds;
  const daysToExpiry = daysBetween(today, expiryDate);
  let status = "ok";
  if (daysToExpiry < 0) status = "expired";
  else if (daysToExpiry <= criticalExpiryDays) status = "critical";
  else if (daysToExpiry <= nearExpiryDays) status = "near_expiry";
  return { status, daysToExpiry };
}

function thresholdsOf(warehouse) {
  if (!warehouse) return DEFAULT_THRESHOLDS;
  return {
    nearExpiryDays: warehouse.near_expiry_days ?? warehouse.nearExpiryDays,
    criticalExpiryDays: warehouse.critical_expiry_days ?? warehouse.criticalExpiryDays,
  };
}

// For a batch stored in several warehouses: the widest (most cautious) thresholds.
function widestThresholds(list) {
  if (list.length === 0) return DEFAULT_THRESHOLDS;
  return {
    nearExpiryDays: Math.max(...list.map((t) => t.nearExpiryDays)),
    criticalExpiryDays: Math.max(...list.map((t) => t.criticalExpiryDays)),
  };
}

module.exports = {
  EXPIRY_STATUSES,
  DEFAULT_THRESHOLDS,
  assertThresholds,
  classifyExpiry,
  thresholdsOf,
  widestThresholds,
};
