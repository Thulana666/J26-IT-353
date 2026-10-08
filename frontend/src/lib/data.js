import { createClient } from "@/lib/supabase/server";
import { demand, events, forecasts, medicineImpacts } from "@/lib/mock-data";

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
    const { data, error } = await supabase
      .from("event_articles")
      .select(
        `id, title, url, country_code, language, processing_status, published_at, fetched_at,
         source:data_sources (name, source_type, country_code),
         event:events (title)`
      )
      .in("id", ids);
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
