import { createClient } from "@/lib/supabase/server";
import { demand, events, forecasts, medicineImpacts } from "@/lib/mock-data";
import { NEWS_PER_PAGE, NEWS_COLUMNS, applyNewsQuery, toNewsItem } from "@/lib/news";

// Data access for the dashboard. Functions backed by Supabase use the
// signed-in user's session, so row level security applies. The rest still
// return mock data until their tables are populated.

// Articles per page on the Articles / Sources page.
export const ARTICLES_PER_PAGE = 25;
// PostgREST returns at most 1000 rows per request.
const INDEX_BATCH_SIZE = 1000;

export async function getEvents() {
  return [...events].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const titleKey = (title) => title.trim().toLowerCase().replace(/\s+/g, " ");

// Light list of every stored article (id, title, source), newest first.
async function getArticleIndex(supabase) {
  const rows = [];
  for (let from = 0; ; from += INDEX_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("event_articles")
      .select("id, title, data_source_id")
      // Failed analyses are retried automatically and not shown until they succeed.
      .neq("processing_status", "failed")
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("fetched_at", { ascending: false })
      .order("id")
      .range(from, from + INDEX_BATCH_SIZE - 1);
    if (error) throw new Error(`Could not load articles: ${error.message}`);
    rows.push(...data);
    if (data.length < INDEX_BATCH_SIZE) return rows;
  }
}

// Totals for summary cards (all stored articles, all sources).
export async function getArticleStats() {
  const index = await getArticleIndex(await createClient());
  return { stored: index.length, sourceCount: new Set(index.map((row) => row.data_source_id)).size };
}

// One page of articles for the Articles / Sources page. Several reports can
// share a title (e.g. WHO updates on the same outbreak): only the newest of
// each is listed; the database keeps them all for event analysis.
export async function getArticlesPage(requestedPage = 1) {
  const supabase = await createClient();
  const index = await getArticleIndex(supabase);

  const seen = new Set();
  const unique = index.filter((row) => {
    const key = titleKey(row.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const pageCount = Math.max(1, Math.ceil(unique.length / ARTICLES_PER_PAGE));
  const page = Math.min(Math.max(1, Math.floor(Number(requestedPage)) || 1), pageCount);
  const ids = unique.slice((page - 1) * ARTICLES_PER_PAGE, page * ARTICLES_PER_PAGE).map((row) => row.id);

  let articles = [];
  if (ids.length > 0) {
    const base = `id, title, url, country_code, language, processing_status, published_at, fetched_at,
         source:data_sources (name, source_type, country_code),
         event:events (title)`;
    let { data, error } = await supabase
      .from("event_articles")
      .select(`${base}, ${ANALYSIS_COLUMNS}`)
      .in("id", ids);
    // Before the analysis migration is applied, show the articles without analysis.
    if (error && isMissingColumn(error)) {
      ({ data, error } = await supabase.from("event_articles").select(base).in("id", ids));
    }
    if (error) throw new Error(`Could not load articles: ${error.message}`);
    const byId = new Map(data.map((row) => [row.id, row]));
    articles = ids.map((id) => byId.get(id)).filter(Boolean).map(toArticle);
  }

  return {
    articles,
    page,
    pageCount,
    pageSize: ARTICLES_PER_PAGE,
    total: unique.length,
    hidden: index.length - unique.length,
    stored: index.length,
  };
}

function toArticle(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source?.name,
    sourceType: row.source?.source_type,
    // The article's own country, falling back to the source's country.
    countryCode: row.country_code ?? row.source?.country_code ?? null,
    language: row.language,
    processingStatus: row.processing_status,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    eventTitle: row.event?.title ?? null,
    // NLP analysis (null until processed; see supabase/migrations/20261021000000_*).
    eventCategory: row.event_category ?? null,
    sriLankaRelevance: row.sri_lanka_relevance ?? null,
    relevanceReason: row.relevance_reason ?? null,
    needsReview: row.needs_review ?? false,
    processingError: row.processing_error ?? null,
  };
}

const ANALYSIS_COLUMNS = "processing_error, event_category, sri_lanka_relevance, relevance_reason, needs_review";
// PostgREST / Postgres "column does not exist".
const isMissingColumn = (error) => error?.code === "42703" || /column .* does not exist/i.test(error?.message ?? "");

// Article counts per processing state, plus processed articles awaiting human review.
export async function getArticleProcessingCounts() {
  const supabase = await createClient();
  const count = async (build) => {
    const { count, error } = await build(supabase.from("event_articles").select("id", { count: "exact", head: true }));
    if (error) throw error;
    return count ?? 0;
  };
  const statuses = ["pending", "processing", "processed"];
  const values = await Promise.all(statuses.map((s) => count((q) => q.eq("processing_status", s))));
  const counts = Object.fromEntries(statuses.map((s, i) => [s, values[i]]));
  try {
    counts.needsReview = await count((q) => q.eq("needs_review", true));
  } catch (error) {
    if (!isMissingColumn(error)) throw new Error(`Could not count articles: ${error.message}`);
    counts.needsReview = null; // migration not applied yet
  }
  return counts;
}

// Recent News: analysed articles with a direct, indirect or uncertain Sri Lankan
// connection, newest publication first (see lib/news.js for filters).
export async function getRecentNews(filters) {
  const supabase = await createClient();
  const { data, error, count } = await applyNewsQuery(
    supabase.from("event_articles").select(NEWS_COLUMNS, { count: "exact" }),
    filters
  );
  if (error) {
    // Asking for a page past the end (e.g. after narrowing a filter) is not an error.
    if (error.code === "PGRST103") return { items: [], total: count ?? 0, page: filters.page, pageCount: 1 };
    throw new Error(`Could not load news: ${error.message}`);
  }
  const total = count ?? 0;
  return { items: data.map(toNewsItem), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / NEWS_PER_PAGE)) };
}

// When news data last changed: newest collection and newest completed analysis,
// read from the database (so it is right even when the backend is not running).
export async function getNewsFreshness() {
  const supabase = await createClient();
  const latest = async (column) => {
    const { data, error } = await supabase
      .from("event_articles")
      .select(column)
      .not(column, "is", null)
      .order(column, { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Could not read ${column}: ${error.message}`);
    return data?.[column] ?? null;
  };
  const count = async (status) => {
    const { count, error } = await supabase.from("event_articles").select("id", { count: "exact", head: true }).eq("processing_status", status);
    if (error) throw new Error(`Could not count articles: ${error.message}`);
    return count ?? 0;
  };
  const [lastCollectedAt, lastAnalysedAt, pending] = await Promise.all([
    latest("fetched_at"), latest("processed_at"), count("pending"),
  ]);
  return { lastCollectedAt, lastAnalysedAt, pending };
}

// Totals for the Recent News summary cards (same base set as the list, no filters).
export async function getNewsSummary() {
  const supabase = await createClient();
  const base = () =>
    supabase
      .from("event_articles")
      .select("id", { count: "exact", head: true })
      .eq("processing_status", "processed")
      .or("event_category.is.null,event_category.neq.other");
  const run = async (q) => {
    const { count, error } = await q;
    if (error) throw new Error(`Could not count news: ${error.message}`);
    return count ?? 0;
  };
  const [direct, indirect, uncertain, review] = await Promise.all([
    run(base().eq("sri_lanka_relevance", "direct")),
    run(base().eq("sri_lanka_relevance", "indirect")),
    run(base().eq("sri_lanka_relevance", "uncertain")),
    run(base().in("sri_lanka_relevance", ["direct", "indirect", "uncertain"]).eq("needs_review", true)),
  ]);
  return { direct, indirect, uncertain, review };
}

// Sources for the Recent News source filter.
export async function getNewsSources() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("data_sources").select("id, name").order("name");
  if (error) throw new Error(`Could not load sources: ${error.message}`);
  return data;
}

// Events generated by the NLP pipeline from collected articles, newest first.
export async function getDetectedEvents() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("events")
    .select(
      `id, title, event_type, severity, status, scope, started_at, sri_lanka_relevance, needs_review, analysis,
       disease:diseases (name),
       locations:event_locations (is_primary, location:locations (name, location_type)),
       articles:event_articles (count)`
    )
    .eq("generated_by", "nlp_pipeline")
    .order("started_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingColumn(error)) return { events: [], migrationMissing: true };
    throw new Error(`Could not load events: ${error.message}`);
  }
  return {
    migrationMissing: false,
    events: data.map((row) => ({
      id: row.id,
      title: row.title,
      eventType: row.event_type,
      category: row.analysis?.category ?? null,
      severity: row.severity,
      status: row.status,
      scope: row.scope,
      startedAt: row.started_at,
      sriLankaRelevance: row.sri_lanka_relevance,
      needsReview: row.needs_review,
      disease: row.disease?.name ?? null,
      locations: [...(row.locations ?? [])]
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
        .map((l) => l.location?.name)
        .filter(Boolean),
      articleCount: row.articles?.[0]?.count ?? 0,
    })),
  };
}

export async function getMedicineImpacts() {
  const eventTitles = Object.fromEntries(events.map((e) => [e.id, e.title]));
  return medicineImpacts
    .map((impact) => ({ ...impact, eventTitle: eventTitles[impact.eventId] }))
    .sort((a, b) => Math.abs(b.expectedChangePct) - Math.abs(a.expectedChangePct));
}

export async function getDemand() {
  return demand.map((row) => ({
    ...row,
    changePct: Math.round(((row.last30Days - row.baseline) / row.baseline) * 100),
  }));
}

export async function getForecasts() {
  return forecasts.map((row) => {
    const total = row.weeks.reduce((sum, value) => sum + value, 0);
    const baselineTotal = row.weeklyBaseline * row.weeks.length;
    return {
      ...row,
      total,
      changePct: Math.round(((total - baselineTotal) / baselineTotal) * 100),
    };
  });
}
