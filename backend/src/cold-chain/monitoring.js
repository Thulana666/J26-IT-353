// Monitoring settings and derived shipment state (pure functions).

const { STRICTNESS, DEFAULT_LIMITS, CONNECTION } = require("./constants");

// Default limits for the strictest storage condition among the shipment's
// items. `mixed` warns that items need different conditions.
function defaultLimits(conditions) {
  const present = new Set(conditions.filter(Boolean));
  const storageCondition = STRICTNESS.find((condition) => present.has(condition)) ?? "ambient";
  return { storageCondition, mixed: present.size > 1, ...DEFAULT_LIMITS[storageCondition] };
}

// Applies requested changes to limits and checks the result is a valid range.
// Returns { limits } or { errors: { field: message } }.
function mergeLimits(current, changes) {
  const limits = { ...current };
  for (const key of ["tempMinC", "tempMaxC", "humidityMinPct", "humidityMaxPct"]) {
    if (changes[key] !== undefined) limits[key] = changes[key];
  }
  const errors = {};
  if (!(limits.tempMinC < limits.tempMaxC)) errors.tempMaxC = "must be above the minimum temperature";
  if (limits.humidityMinPct !== null && limits.humidityMaxPct !== null && !(limits.humidityMinPct < limits.humidityMaxPct)) {
    errors.humidityMaxPct = "must be above the minimum humidity";
  }
  return Object.keys(errors).length ? { errors } : { limits };
}

// How fresh the newest reading is, measured in reading intervals.
function connectionStatus({ lastReadingAt, intervalSeconds, monitoringStatus, now = Date.now() }) {
  const age = lastReadingAt ? Math.max(0, Math.round((now - Date.parse(lastReadingAt)) / 1000)) : null;
  let status;
  if (monitoringStatus === "ended") status = "ended";
  else if (age === null) status = "no_data";
  else if (age <= intervalSeconds * CONNECTION.onlineIntervals) status = "online";
  else if (age <= intervalSeconds * CONNECTION.delayedIntervals) status = "delayed";
  else status = "offline";
  return { status, lastReadingAt: lastReadingAt ?? null, secondsSinceLastReading: age };
}

// Expected vs actual delivery. Actual delivery is when the pharmacy received
// the shipment (Component 4).
function deliveryStatus({ shipmentStatus, dispatchedAt, expectedDeliveryAt, receivedAt, now = Date.now() }) {
  const expected = expectedDeliveryAt ? Date.parse(expectedDeliveryAt) : null;
  const delivered = receivedAt ? Date.parse(receivedAt) : null;
  const delayMinutes = expected === null ? null : Math.max(0, Math.round(((delivered ?? now) - expected) / 60_000));
  return {
    status: shipmentStatus,
    dispatchedAt,
    expectedDeliveryAt: expectedDeliveryAt ?? null,
    actualDeliveryAt: receivedAt ?? null,
    isDelivered: delivered !== null,
    isOverdue: delivered === null && expected !== null && now > expected,
    delayMinutes,
  };
}

module.exports = { defaultLimits, mergeLimits, connectionStatus, deliveryStatus };
