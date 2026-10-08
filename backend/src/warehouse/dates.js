// Calendar dates as "YYYY-MM-DD" strings in the warehouse's time zone
// (default Sri Lanka), so "today" does not depend on the server's zone.
// ISO date strings compare correctly with < and >.

const TIME_ZONE = process.env.WAREHOUSE_TIME_ZONE || "Asia/Colombo";
const DAY_MS = 24 * 60 * 60 * 1000;

function todayISO(now = new Date(), timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isISODate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Whole days from `fromISO` to `toISO` (negative when `toISO` is earlier).
function daysBetween(fromISO, toISO) {
  return Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY_MS);
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

module.exports = { todayISO, isISODate, daysBetween, addDays, TIME_ZONE };
