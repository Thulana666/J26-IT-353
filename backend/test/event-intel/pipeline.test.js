const test = require("node:test");
const assert = require("node:assert/strict");
const { AlreadyRunning, getPipelineState, runExclusive, startPipeline } = require("../../src/event-intel/pipeline");

// Pending-count query used at the end of a job.
const supabase = { from: () => ({ select: () => ({ eq: async () => ({ count: 3, error: null }) }) }) };

const batch = (over = {}) => ({ attempted: 0, processed: 0, failed: 0, needsReview: 0, eventsLinked: 0, stopped: null, errors: [], ...over });

// Process stub: returns the given batches in order, then "nothing left".
function processor(batches) {
  const calls = [];
  const fn = async (_db, options) => {
    calls.push(options.limit);
    const next = batches.shift() ?? batch();
    const n = Math.min(next.attempted, options.limit); // like the real processor, never more than the limit
    return { ...next, attempted: n, processed: Math.min(next.processed, n) };
  };
  fn.calls = calls;
  return fn;
}

const finished = () => new Promise((resolve) => {
  const wait = () => (getPipelineState().busy ? setTimeout(wait, 5) : resolve(getPipelineState().last));
  wait();
});

test("a run starts in the background, collects, processes in batches and reports counts", async () => {
  const process = processor([batch({ attempted: 25, processed: 24, failed: 1, needsReview: 10, eventsLinked: 7, errors: [{ articleId: "a", error: "x" }] }),
    batch({ attempted: 5, processed: 5, needsReview: 2 })]);
  const collect = async () => [{ source: "WHO", status: "ok", inserted: 4 }, { source: "NewsAPI", status: "skipped", inserted: 0 }];
  const job = startPipeline(supabase, { collect, process });
  assert.equal(job.status, "running"); // returned before the work finishes
  const last = await finished();
  assert.deepEqual([last.status, last.collected, last.sourcesSkipped, last.attempted, last.processed, last.failed, last.needsReview, last.eventsLinked, last.remainingPending],
    ["partial", 4, 1, 30, 29, 1, 12, 7, 3]); // partial: one article failed (it stays retryable)
  assert.equal(process.calls.length, 3); // two batches + one empty check
  assert.equal(getPipelineState().lastSuccess.id, last.id);
});

test("overlapping runs are refused, including while Refresh or Analyse pending holds the lock", async () => {
  let release;
  const collect = () => new Promise((resolve) => { release = () => resolve([]); });
  startPipeline(supabase, { collect, process: processor([]) });
  assert.throws(() => startPipeline(supabase, { collect, process: processor([]) }), (e) => e instanceof AlreadyRunning && e.job?.status === "running");
  await assert.rejects(runExclusive(async () => {}), AlreadyRunning);
  release();
  await finished();

  let unlock;
  const held = runExclusive(() => new Promise((resolve) => { unlock = resolve; }), "Analyse pending");
  assert.throws(() => startPipeline(supabase, { collect: async () => [], process: processor([]) }), /Analyse pending/);
  unlock();
  await held;
});

test("AI service unavailable: run stops, is reported, and does not count as the last success", async () => {
  const before = getPipelineState().lastSuccess?.id;
  startPipeline(supabase, { collect: async () => [], process: processor([batch({ stopped: "AI service not reachable at http://localhost:8000" })]) });
  const last = await finished();
  assert.equal(last.status, "partial");
  assert.match(last.stopped, /not reachable/);
  assert.equal(getPipelineState().lastSuccess?.id, before);
});

test("a collection failure still analyses already-pending articles", async () => {
  startPipeline(supabase, { collect: async () => { throw new Error("network down"); }, process: processor([batch({ attempted: 2, processed: 2 })]) });
  const last = await finished();
  assert.equal(last.collectionError, "network down");
  assert.equal(last.processed, 2);
  assert.equal(last.status, "partial");
});

test("a job is bounded by maxArticles", async () => {
  const process = processor(Array.from({ length: 10 }, () => batch({ attempted: 25, processed: 25 })));
  startPipeline(supabase, { collect: async () => [], process, maxArticles: 60 });
  const last = await finished();
  assert.equal(last.attempted, 60);
  assert.deepEqual(process.calls, [25, 25, 10]);
  assert.equal(last.status, "completed");
});

test("an unexpected error marks the job failed", async () => {
  startPipeline(supabase, { collect: async () => [], process: async () => { throw new Error("schema missing"); } });
  const last = await finished();
  assert.deepEqual([last.status, last.error], ["failed", "schema missing"]);
});

test("the schedule starts runs on its interval and skips a tick while a run is in progress", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { startSchedule, scheduleInfo } = require("../../src/event-intel/pipeline");
  const warn = t.mock.method(console, "warn", () => {});
  let unlock;
  const held = runExclusive(() => new Promise((resolve) => { unlock = resolve; }), "Refresh");
  const timer = startSchedule(supabase, 30);
  assert.equal(scheduleInfo().intervalMinutes, 30);
  t.mock.timers.tick(30 * 60_000); // busy: skipped
  assert.match(warn.mock.calls[0].arguments[0], /scheduled run skipped: .*Refresh/);
  unlock();
  await held;
  clearInterval(timer);
});
