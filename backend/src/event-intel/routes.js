// Endpoints the dashboard uses to analyse articles. Only the Next.js server
// calls these (with INGESTION_API_KEY), never the browser.

const express = require("express");
const supabase = require("../config/supabase");
const { isAuthorized } = require("../ingestion/auth");
const { processArticles } = require("./process-articles");
const { AlreadyRunning, getPipelineState, runExclusive, scheduleInfo, startPipeline } = require("./pipeline");

const router = express.Router();

router.use((req, res, next) => {
  if (!process.env.INGESTION_API_KEY?.trim()) {
    return res.status(503).json({ error: "INGESTION_API_KEY is not set on the backend" });
  }
  if (!isAuthorized(req.get("x-ingestion-key"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// POST /api/event-intel/process  { limit? }  -> processing summary (one bounded batch, synchronous).
router.post("/process", async (req, res) => {
  const started = Date.now();
  try {
    const summary = await runExclusive(() => processArticles(supabase, { limit: req.body?.limit }), "Analyse pending");
    console.log(
      `[event-intel] processed ${summary.processed}, failed ${summary.failed}, review ${summary.needsReview} ` +
        `in ${Math.round((Date.now() - started) / 1000)}s${summary.stopped ? ` (stopped: ${summary.stopped})` : ""}`
    );
    res.json(summary);
  } catch (error) {
    if (error instanceof AlreadyRunning) return res.status(409).json({ error: error.message });
    console.error(`[event-intel] processing failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/event-intel/run -> 202 { job }: collect + analyse in the background.
// 409 { error, job } while another run is in progress.
router.post("/run", (req, res) => {
  try {
    res.status(202).json({ job: startPipeline(supabase, { trigger: "manual" }) });
  } catch (error) {
    if (error instanceof AlreadyRunning) return res.status(409).json({ error: error.message, job: error.job });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/event-intel/status -> running job (if any), last and last successful runs, schedule.
router.get("/status", (req, res) => {
  res.json({ ...getPipelineState(), schedule: scheduleInfo() });
});

module.exports = { eventIntelRouter: router, runExclusive, AlreadyRunning };
