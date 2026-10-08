// HTTP trigger for article ingestion, used by the dashboard's Refresh button.
// Protected by a shared secret (INGESTION_API_KEY) that only the Next.js
// server knows; the browser never calls this endpoint directly.

const crypto = require("node:crypto");
const express = require("express");
const supabase = require("../config/supabase");
const { collectArticles } = require("./collect-articles");

const router = express.Router();
let running = false;

function isAuthorized(provided) {
  const expected = process.env.INGESTION_API_KEY?.trim();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(provided));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/ingestion/articles  -> runs every source, returns per-source results.
router.post("/articles", async (req, res) => {
  if (!process.env.INGESTION_API_KEY?.trim()) {
    return res.status(503).json({ error: "INGESTION_API_KEY is not set on the backend" });
  }
  if (!isAuthorized(req.get("x-ingestion-key"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // One run at a time (also keeps request rates polite to the sources).
  if (running) {
    return res.status(409).json({ error: "Article collection is already running" });
  }

  running = true;
  const started = Date.now();
  try {
    const results = await collectArticles(supabase);
    const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
    console.log(`[ingestion] ${inserted} new article(s) in ${Math.round((Date.now() - started) / 1000)}s`);
    res.json({ inserted, results });
  } catch (error) {
    console.error(`[ingestion] failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  } finally {
    running = false;
  }
});

module.exports = router;
