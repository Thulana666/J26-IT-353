// Calendar dates ("YYYY-MM-DD") in the pharmacy's time zone, and expiry status.
// No database access, so the analytics can be unit tested.

const warehouseDates = require("../warehouse/dates");

const TIME_ZONE = process.env.PHARMACY_TIME_ZONE || "Asia/Colombo";
const CRITICAL_EXPIRY_DAYS = 30;

const today = (now = new Date()) => warehouseDates.todayISO(now, TIME_ZONE);
const { addDays, daysBetween } = warehouseDates;

// expired: past the expiry date (the expiry date itself is still usable);
// critical: within 30 days; near_expiry: within the pharmacy's threshold.
function expiryStatus(expiryDate, todayISO, nearExpiryDays) {
  const days = daysBetween(todayISO, expiryDate);
  if (days < 0) return "expired";
  if (days <= CRITICAL_EXPIRY_DAYS) return "critical";
  if (days <= nearExpiryDays) return "near_expiry";
  return "ok";
}

module.exports = { TIME_ZONE, CRITICAL_EXPIRY_DAYS, today, addDays, daysBetween, expiryStatus };
