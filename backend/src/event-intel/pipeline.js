// Background job behind the "Run AI services" button: collect new articles,
// then analyse whatever is pending in batches. The same job can also run on a
// timer (EVENT_INTEL_PIPELINE_INTERVAL_MINUTES, off by default).
//
// Only one run at a time - Refresh, Analyse pending, Run AI services and the
// timer all go through runExclusive(). Job status is kept in memory, so it
// resets on restart, but unfinished articles just get picked up next time.

const crypto = require("node:crypto");
const { collectArticles } = require("../ingestion/collect-articles");
const { processArticles, DEFAULT_LIMIT } = require("./process-articles");

// Cap per run so one click can't run for hours. The rest waits for the next run.
const DEFAULT_MAX_ARTICLES = 500;
const HISTORY = 10;

class AlreadyRunning extends Error {}

let busy = null; // name of the running task, or null

async function runExclusive(fn, name = "article analysis") {
  if (busy) throw new AlreadyRunning(`Another run is in progress (${busy})`);
  busy = name;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

const state = { current: null, history: [], lastSuccess: null };

const snapshot = (job) => (job ? JSON.parse(JSON.stringify(job)) : null);

function getPipelineState() {
  return {
    busy,
    current: snapshot(state.current),
    last: snapshot(state.history[0] ?? null),
    lastSuccess: snapshot(state.lastSuccess),
    history: state.history.map(snapshot),
  };
}

async function execute(supabase, job, { maxArticles, collect, process }) {
  job.stage = "collecting";
  try {
    const results = await collect(supabase);
    job.sources = results.map(({ source, status, inserted, error }) => ({ source, status, inserted, error: error ?? null }));
    job.collected = results.reduce((sum, r) => sum + (r.inserted ?? 0), 0);
    job.sourcesFailed = results.filter((r) => r.status === "failed").length;
    job.sourcesSkipped = results.filter((r) => r.status === "skipped").length;
  } catch (error) {
    // A collection failure does not block analysing what is already pending.
    job.sources = [];
    job.collectionError = error.message;
  }

  job.stage = "processing";
  while (job.attempted < maxArticles) {
    const summary = await process(supabase, { limit: Math.min(DEFAULT_LIMIT, maxArticles - job.attempted) });
    job.attempted += summary.attempted;
    job.processed += summary.processed;
    job.failed += summary.failed;
    job.needsReview += summary.needsReview;
    job.eventsLinked += summary.eventsLinked;
    job.errors.push(...summary.errors.slice(0, 20 - job.errors.length));
    if (summary.stopped) {
      job.stopped = summary.stopped; // e.g. AI service unreachable or no model loaded
      break;
    }
    if (summary.attempted === 0) break; // nothing eligible left
  }
}

// Starts a job in the background and returns it immediately.
// Throws AlreadyRunning (with .job = the running job) if one is in progress.
function startPipeline(supabase, { trigger = "manual", maxArticles = DEFAULT_MAX_ARTICLES,
  collect = collectArticles, process = processArticles, onDone } = {}) {
  if (busy) {
    const error = new AlreadyRunning(`Another run is in progress (${busy})`);
    error.job = snapshot(state.current);
    throw error;
  }
  const job = {
    id: crypto.randomUUID(), trigger, status: "running", stage: "starting",
    startedAt: new Date().toISOString(), finishedAt: null,
    collected: 0, sources: [], sourcesFailed: 0, sourcesSkipped: 0, collectionError: null,
    attempted: 0, processed: 0, failed: 0, needsReview: 0, eventsLinked: 0, remainingPending: null,
    stopped: null, error: null, errors: [],
  };
  state.current = job;

  const done = runExclusive(async () => {
    try {
      await execute(supabase, job, { maxArticles, collect, process });
      job.remainingPending = await countPending(supabase).catch(() => null);
      // "partial" means it finished but something went wrong along the way.
      job.status = job.stopped || job.failed > 0 || job.collectionError || job.sourcesFailed > 0 ? "partial" : "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error.message;
    } finally {
      job.stage = "done";
      job.finishedAt = new Date().toISOString();
      if (job.status !== "failed" && !job.stopped) state.lastSuccess = job;
      state.history.unshift(job);
      state.history.length = Math.min(state.history.length, HISTORY);
      state.current = null;
      const line = `[event-intel] ${trigger} run ${job.status}: collected ${job.collected}, processed ${job.processed}, ` +
        `failed ${job.failed}, review ${job.needsReview}, still pending ${job.remainingPending ?? "?"}` +
        `${job.stopped ? ` (stopped: ${job.stopped})` : ""}${job.error ? ` (error: ${job.error})` : ""}`;
      (job.status === "completed" ? console.log : console.error)(line);
      onDone?.(job);
    }
  }, `${trigger} run`);
  done.catch(() => {}); // errors are recorded on the job
  return snapshot(job);
}

async function countPending(supabase) {
  const { count, error } = await supabase
    .from("event_articles")
    .select("id", { count: "exact", head: true })
    .eq("processing_status", "pending");
  if (error) throw error;
  return count;
}

// Optional schedule. A tick is skipped (and logged) while another run is in progress.
function startSchedule(supabase, intervalMinutes) {
  const tick = () => {
    schedule.lastTickAt = new Date().toISOString();
    try {
      startPipeline(supabase, { trigger: "schedule" });
    } catch (error) {
      console.warn(`[event-intel] scheduled run skipped: ${error.message}`);
    }
  };
  const timer = setInterval(tick, intervalMinutes * 60_000);
  timer.unref();
  schedule.intervalMinutes = intervalMinutes;
  schedule.lastTickAt = new Date().toISOString();
  console.log(`[event-intel] news pipeline scheduled every ${intervalMinutes} min`);
  return timer;
}

const schedule = { intervalMinutes: 0, lastTickAt: null };

function scheduleInfo() {
  if (!schedule.intervalMinutes) return { enabled: false, intervalMinutes: 0 };
  return { enabled: true, intervalMinutes: schedule.intervalMinutes,
    nextRunAt: new Date(Date.parse(schedule.lastTickAt) + schedule.intervalMinutes * 60_000).toISOString() };
}

module.exports = { startPipeline, getPipelineState, runExclusive, startSchedule, scheduleInfo, AlreadyRunning, DEFAULT_MAX_ARTICLES };
