// Shared-secret check for server-to-server triggers (INGESTION_API_KEY), used
// by article collection and article processing. Only the Next.js server knows
// the key; the browser never calls these endpoints directly.

const crypto = require("node:crypto");

function isAuthorized(provided) {
  const expected = process.env.INGESTION_API_KEY?.trim();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(provided));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isAuthorized };
