// HTTP trigger for article ingestion, used by the dashboard's Refresh button.
// Protected by a shared secret (INGESTION_API_KEY) that only the Next.js
// server knows; the browser never calls this endpoint directly.

const express = require("express");
const supabase = require("../config/supabase");
const { collectArticles } = require("./collect-articles");
const { isAuthorized } = require("./auth");
const { processArticles } = require("../event-intel/process-articles");
const { AlreadyRunning, runExclusive } = require("../event-intel/pipeline");

const router = express.Router();

// Articles analysed right after each collection; the rest wait for the next
// run or POST /api/event-intel/process.
const ANALYSE_AFTER_COLLECT = 25;

// POST /api/ingestion/articles  -> runs every source, returns per-source results.
router.post("/articles", async (req, res) => {
  if (!process.env.INGESTION_API_KEY?.trim()) {
    return res.status(503).json({ error: "INGESTION_API_KEY is not set on the backend" });
  }
  if (!isAuthorized(req.get("x-ingestion-key"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // One run at a time, shared with analysis and the pipeline (also keeps request rates polite to the sources).
  const started = Date.now();
  try {
    const body = await runExclusive(async () => {
      const results = await collectArticles(supabase);
      const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
      console.log(`[ingestion] ${inserted} new article(s) in ${Math.round((Date.now() - started) / 1000)}s`);
      // Analysis problems never fail the collection: they are reported alongside it.
      let analysis;
      try {
        analysis = await processArticles(supabase, { limit: ANALYSE_AFTER_COLLECT });
      } catch (error) {
        console.error(`[event-intel] analysis after collection failed: ${error.message}`);
        analysis = { error: error.message };
      }
      return { inserted, results, analysis };
    }, "Refresh");
    res.json(body);
  } catch (error) {
    if (error instanceof AlreadyRunning) return res.status(409).json({ error: error.message });
    console.error(`[ingestion] failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
