import { createClient } from "@/lib/supabase/server";
import { demand, events, forecasts, medicineImpacts } from "@/lib/mock-data";

// Data access for the dashboard. Functions backed by Supabase use the
// signed-in user's session, so row level security applies. The rest still
// return mock data until their tables are populated.

// Most recent articles shown on the Articles / Sources page.
export const ARTICLE_LIMIT = 100;

export async function getEvents() {
  return [...events].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Articles with their source (and linked event, once NLP links them),
// newest first.
export async function getArticles() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("event_articles")
    .select(
      `id, title, url, country_code, language, processing_status, published_at, fetched_at,
       source:data_sources (name, source_type, country_code),
       event:events (title)`
    )
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("fetched_at", { ascending: false })
    .limit(ARTICLE_LIMIT);

  if (error) {
    throw new Error(`Could not load articles: ${error.message}`);
  }

  return data.map((row) => ({
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
  }));
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
