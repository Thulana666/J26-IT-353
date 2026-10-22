// Article processor: pending event_articles -> AI service (POST /event-intel/classify)
// -> analysis, Sri Lanka relevance, review flag and (for relevant events) an
// NLP-generated event -> processing_status = processed.
//
// Reliability rules:
//   * Bounded: at most `limit` articles per run, each tried at most MAX_ATTEMPTS times.
//   * Each article is claimed with a conditional update, so two runs never
//     process the same article; a claim left in 'processing' by a crashed run
//     is reclaimed after STALE_MINUTES.
//   * An article is marked processed only after its analysis (and event link)
//     has been written. Event creation is keyed by events.dedupe_key, so retries
//     never duplicate events or links.
//   * Service-level problems (no model loaded, service unreachable) stop the run
//     and release the claimed article without using up an attempt.

const { analysisVersion, assessRelevance, buildRequest, eventPlan, precheck } = require("./assess");

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 15;
const GROUP_WINDOW_DAYS = 28; // a related article joins an event of its group started this close
const RETRY_AFTER_MINUTES = 5; // a failed article waits this long before its next attempt
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const TIMEOUT_MS = 30_000;

const aiUrl = () => (process.env.AI_SERVICE_URL || process.env.SPATIAL_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");

const ARTICLE_COLUMNS = `id, title, summary, content, url, language, country_code, published_at, fetched_at,
  processing_status, processing_attempts, processing_started_at,
  source:data_sources (name, source_type)`;

class ServiceUnavailable extends Error {}
class PermanentFailure extends Error {}

// One classify call. Throws ServiceUnavailable (stop the run), PermanentFailure
// (bad input: do not retry) or Error (retry later).
async function classify(article, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(`${aiUrl()}/event-intel/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest(article)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error(`AI service timed out after ${timeoutMs / 1000}s`);
    console.warn(`[event-intel] AI service not reachable at ${aiUrl()}: ${error.message}`);
    throw new ServiceUnavailable("The AI service is not running. Start it, then analyse again.");
  }
  const body = await response.json().catch(() => ({}));
  const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body).slice(0, 500);
  if (response.status === 501) {
    console.warn(`[event-intel] AI service has no model loaded: ${detail}`);
    throw new ServiceUnavailable("The AI model is not loaded. Check EVENT_INTEL_MODEL_DIR in ai-service/.env and restart the AI service.");
  }
  if (response.status === 422) throw new PermanentFailure(`AI service rejected the article (422): ${detail}`);
  if (!response.ok) throw new Error(`AI service error ${response.status}: ${detail}`);
  if (body.model?.status !== "ok") throw new ServiceUnavailable("The AI model is not loaded. Restart the AI service.");
  return body;
}

// Candidates: pending, failed with attempts left (after a short wait), or stale 'processing' claims.
async function findCandidates(supabase, limit, now) {
  const minutesAgo = (m) => new Date(now.getTime() - m * 60_000).toISOString();
  const stale = minutesAgo(STALE_MINUTES);
  const retry = minutesAgo(RETRY_AFTER_MINUTES);
  const { data, error } = await supabase
    .from("event_articles")
    .select(ARTICLE_COLUMNS)
    .or(
      `processing_status.eq.pending,` +
        `and(processing_status.eq.failed,processing_attempts.lt.${MAX_ATTEMPTS},processing_started_at.lt.${retry}),` +
        `and(processing_status.eq.processing,processing_started_at.lt.${stale})`
    )
    .order("fetched_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Could not load articles to process: ${error.message}`);
  return data;
}

// Conditional claim: succeeds only if nobody changed the row since it was read.
async function claim(supabase, article, now) {
  const { data, error } = await supabase
    .from("event_articles")
    .update({
      processing_status: "processing",
      processing_started_at: now.toISOString(),
      processing_attempts: (article.processing_attempts ?? 0) + 1,
    })
    .eq("id", article.id)
    .eq("processing_status", article.processing_status)
    .eq("processing_attempts", article.processing_attempts ?? 0)
    .select("id");
  if (error) throw new Error(`Could not claim article ${article.id}: ${error.message}`);
  return data.length === 1;
}

async function finish(supabase, articleId, fields) {
  const { data, error } = await supabase
    .from("event_articles")
    .update(fields)
    .eq("id", articleId)
    .eq("processing_status", "processing")
    .select("id");
  if (error) throw new Error(`Could not update article ${articleId}: ${error.message}`);
  if (data.length !== 1) throw new Error(`Article ${articleId} is no longer claimed by this run`);
}

async function upsertOne(supabase, table, row, onConflict, columns = "id") {
  const { error } = await supabase.from(table).upsert(row, { onConflict, ignoreDuplicates: true });
  if (error) throw new Error(`Could not save ${table}: ${error.message}`);
  let query = supabase.from(table).select(columns);
  for (const key of onConflict.split(",")) query = row[key] === null ? query.is(key, null) : query.eq(key, row[key]);
  const { data, error: readError } = await query.maybeSingle();
  if (readError || !data) throw new Error(`Could not read back ${table}: ${readError?.message ?? "not found"}`);
  return data;
}

// Location rows for the places the rules found (Sri Lanka > province > district; foreign countries).
async function locationIds(supabase, plan) {
  const ids = [];
  const lk = plan.sriLankaLocations;
  if (lk.length > 0) {
    const country = await upsertOne(supabase, "locations",
      { name: "Sri Lanka", location_type: "country", parent_id: null, country_code: "LK" }, "name,location_type,parent_id");
    const provinces = new Map();
    const province = async (name) => {
      if (!provinces.has(name)) {
        provinces.set(name, (await upsertOne(supabase, "locations",
          { name, location_type: "province", parent_id: country.id, country_code: "LK" }, "name,location_type,parent_id")).id);
      }
      return provinces.get(name);
    };
    for (const place of lk) {
      if (place.type === "province") ids.push(await province(place.name));
      else if (place.type === "district") {
        const parent = place.province ? await province(place.province) : country.id;
        ids.push((await upsertOne(supabase, "locations",
          { name: place.name, location_type: "district", parent_id: parent, country_code: "LK" }, "name,location_type,parent_id")).id);
      }
    }
    if (ids.length === 0) ids.push(country.id);
  }
  for (const c of plan.foreignCountries) {
    ids.push((await upsertOne(supabase, "locations",
      { name: c.name, location_type: "country", parent_id: null, country_code: c.code ?? null }, "name,location_type,parent_id")).id);
  }
  return [...new Set(ids)];
}

// Nearest existing event of the same group (category + anchor) within the window.
async function findGroupEvent(supabase, plan) {
  const day = 86_400_000;
  const start = Date.parse(plan.startedAt);
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("events")
    .select("id, needs_review, sri_lanka_relevance, status, started_at")
    .eq("generated_by", "nlp_pipeline")
    .eq("analysis->>group", plan.group)
    .gte("started_at", iso(start - GROUP_WINDOW_DAYS * day))
    .lte("started_at", iso(start + GROUP_WINDOW_DAYS * day));
  if (error) throw new Error(`Could not look up related events: ${error.message}`);
  if (data.length === 0) return null;
  return data.reduce((best, e) => (Math.abs(Date.parse(e.started_at) - start) < Math.abs(Date.parse(best.started_at) - start) ? e : best));
}

// Create (once) or reuse the event for this article and merge its flags.
async function linkEvent(supabase, article, plan, assessment, needsReview) {
  const disease = plan.diseaseNames[0]
    ? await upsertOne(supabase, "diseases", { name: plan.diseaseNames[0] }, "name")
    : null;
  const event = (plan.windowed ? await findGroupEvent(supabase, plan) : null) ?? await upsertOne(
    supabase,
    "events",
    {
      dedupe_key: plan.dedupeKey,
      title: plan.title,
      description: `Generated from collected articles by the NLP pipeline. First article: ${article.title}`,
      event_type: plan.eventType,
      severity: null, // not assessed by the pipeline
      status: needsReview ? "monitoring" : "active",
      scope: plan.scope,
      disease_id: disease?.id ?? null,
      started_at: plan.startedAt,
      generated_by: "nlp_pipeline",
      sri_lanka_relevance: assessment.relevance,
      needs_review: needsReview,
      analysis: { category: plan.category, diseases: plan.diseaseNames, hazard: plan.hazard, alert_id: plan.alertId,
        group: plan.group, standalone: plan.standalone,
        grouping: plan.windowed ? `same identity, started within ${GROUP_WINDOW_DAYS} days`
          : plan.standalone ? "single article (identity too weak to merge)" : "same alert identifier" },
    },
    "dedupe_key",
    "id, needs_review, sri_lanka_relevance, status, started_at"
  );

  // A later article can only raise the review flag or upgrade indirect -> direct.
  const update = {};
  if (needsReview && !event.needs_review) Object.assign(update, { needs_review: true, status: "monitoring" });
  if (assessment.relevance === "direct" && event.sri_lanka_relevance !== "direct") update.sri_lanka_relevance = "direct";
  // Articles are not processed in publication order: the event starts at its earliest article's week.
  if (event.started_at && plan.startedAt < event.started_at) update.started_at = plan.startedAt;
  if (Object.keys(update).length > 0) {
    const { error } = await supabase.from("events").update(update).eq("id", event.id);
    if (error) throw new Error(`Could not update event: ${error.message}`);
  }

  const locations = await locationIds(supabase, plan);
  if (locations.length > 0) {
    const { error } = await supabase.from("event_locations").upsert(
      locations.map((id, i) => ({ event_id: event.id, location_id: id, is_primary: i === 0 })),
      { onConflict: "event_id,location_id", ignoreDuplicates: true }
    );
    if (error) throw new Error(`Could not link event locations: ${error.message}`);
  }
  return event.id;
}

async function processOne(supabase, article, options) {
  const skipped = precheck(article);
  if (skipped) {
    await finish(supabase, article.id, {
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      processing_error: null,
      sri_lanka_relevance: skipped.relevance,
      relevance_reason: skipped.reason,
      needs_review: true,
      event_category: null,
      analysis: { skipped: true, reason: skipped.reason },
      analysis_version: null,
    });
    return { outcome: "processed", relevance: skipped.relevance, needsReview: true, eventId: null };
  }

  const response = await classify(article, options);
  const assessment = assessRelevance(response);
  const needsReview = Boolean(response.review?.needs_review) || assessment.relevance === "uncertain";
  const plan = eventPlan(article, response, assessment);
  const eventId = plan ? await linkEvent(supabase, article, plan, assessment, needsReview) : null;

  const fields = {
    processing_status: "processed",
    processed_at: new Date().toISOString(),
    processing_error: null,
    event_category: response.hybrid?.category ?? null,
    sri_lanka_relevance: assessment.relevance,
    relevance_reason: assessment.reason,
    needs_review: needsReview,
    analysis: response,
    analysis_version: analysisVersion(response),
  };
  if (eventId) fields.event_id = eventId;
  await finish(supabase, article.id, fields);
  return { outcome: "processed", relevance: assessment.relevance, needsReview, eventId };
}

// Fails loudly (before touching any article) if the migration has not been applied.
async function checkSchema(supabase) {
  const { error } = await supabase
    .from("event_articles")
    .select("id, analysis, sri_lanka_relevance, needs_review, processing_attempts, processing_started_at")
    .limit(1);
  if (error) {
    throw new Error(
      `event_articles is missing the analysis columns (${error.message}). ` +
        "Run supabase/migrations/20261021000000_add_article_analysis_fields.sql first."
    );
  }
}

async function processArticles(supabase, { limit = DEFAULT_LIMIT, now = () => new Date(), ...options } = {}) {
  const max = Math.min(Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT), MAX_LIMIT);
  await checkSchema(supabase);
  const summary = { attempted: 0, processed: 0, failed: 0, needsReview: 0, eventsLinked: 0, stopped: null, errors: [] };
  const candidates = await findCandidates(supabase, max, now());

  for (const article of candidates) {
    if (!(await claim(supabase, article, now()))) continue; // taken by another run
    summary.attempted += 1;
    try {
      const result = await processOne(supabase, article, options);
      summary.processed += 1;
      if (result.needsReview) summary.needsReview += 1;
      if (result.eventId) summary.eventsLinked += 1;
    } catch (error) {
      const attempts = (article.processing_attempts ?? 0) + 1;
      if (error instanceof ServiceUnavailable) {
        // Not the article's fault: give the attempt back and stop the run.
        await finish(supabase, article.id, {
          processing_status: article.processing_status === "processing" ? "pending" : article.processing_status,
          processing_attempts: attempts - 1,
          processing_started_at: article.processing_started_at ?? null,
        }).catch(() => {});
        summary.attempted -= 1;
        summary.stopped = error.message;
        break;
      }
      const permanent = error instanceof PermanentFailure;
      summary.failed += 1;
      summary.errors.push({ articleId: article.id, error: error.message });
      await finish(supabase, article.id, {
        processing_status: "failed",
        processing_error: `${error.message}${permanent ? " (not retried)" : ` (attempt ${attempts} of ${MAX_ATTEMPTS})`}`,
        processing_attempts: permanent ? MAX_ATTEMPTS : attempts,
      }).catch((e) => summary.errors.push({ articleId: article.id, error: e.message }));
    }
  }
  return summary;
}

module.exports = { processArticles, classify, MAX_ATTEMPTS, DEFAULT_LIMIT, MAX_LIMIT, ServiceUnavailable, PermanentFailure };
