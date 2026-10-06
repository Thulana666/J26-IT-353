// Article ingestion: external sources -> event_articles (processing_status = pending).
// No NLP, event creation or relevance scoring happens here.

const who = require("./sources/who");
const reliefweb = require("./sources/reliefweb");
const gdacs = require("./sources/gdacs");
const newsApi = require("./sources/newsapi");
const healthMinistry = require("./sources/health-ministry");
const dailyMirror = require("./sources/daily-mirror");
const dailyNews = require("./sources/daily-news");
const sundayObserver = require("./sources/sunday-observer");
const { findCountryCode } = require("./countries");
const { SourceNotConfigured } = require("./normalize");

// Keys are used on the command line: npm run collect:articles -- gdacs who
const SOURCES = {
  who,
  reliefweb,
  gdacs,
  newsapi: newsApi,
  "health-ministry": healthMinistry,
  "daily-mirror": dailyMirror,
  "daily-news": dailyNews,
  "sunday-observer": sundayObserver,
};

const INSERT_BATCH_SIZE = 200;

// One data_sources row per external source, looked up by its unique name.
async function getOrCreateSource(supabase, definition) {
  const { data: existing, error } = await supabase
    .from("data_sources")
    .select("id, is_active")
    .eq("name", definition.name)
    .maybeSingle();
  if (error) throw new Error(`Could not read data_sources: ${error.message}`);
  if (existing) return existing;

  const { data: created, error: insertError } = await supabase
    .from("data_sources")
    .insert({ ...definition, is_active: true })
    .select("id, is_active")
    .single();
  if (insertError) throw new Error(`Could not create data source: ${insertError.message}`);
  return created;
}

// Inserts new articles; URLs already in event_articles are skipped (unique url),
// so existing rows are never modified and re-running is safe.
async function saveArticles(supabase, sourceId, articles, collectedAt) {
  const byUrl = new Map(articles.map((article) => [article.url, article]));
  const rows = [...byUrl.values()].map((article) => ({
    ...article,
    // A country named in the title wins; otherwise keep the source's default
    // (e.g. LK for Sri Lankan publishers), or null if there is none.
    country_code: findCountryCode(article.title) ?? article.country_code,
    data_source_id: sourceId,
    fetched_at: collectedAt,
    processing_status: "pending",
  }));
  let inserted = 0;
  // Batches keep each request small (ReliefWeb can return 1000 reports).
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const { data, error } = await supabase
      .from("event_articles")
      .upsert(rows.slice(i, i + INSERT_BATCH_SIZE), { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`Could not save articles: ${error.message}`);
    inserted += data.length;
  }
  return { inserted, existing: rows.length - inserted };
}

async function collectArticles(supabase, { only } = {}) {
  const keys = only?.length ? only : Object.keys(SOURCES);
  const unknown = keys.filter((key) => !SOURCES[key]);
  if (unknown.length) {
    throw new Error(`Unknown source(s): ${unknown.join(", ")}. Available: ${Object.keys(SOURCES).join(", ")}`);
  }

  const collectedAt = new Date().toISOString();
  const results = [];

  // Sources run one after another; a failure is recorded and the next continues.
  for (const key of keys) {
    const { source, collect } = SOURCES[key];
    const result = { source: source.name, status: "ok", fetched: 0, relevant: 0, inserted: 0, existing: 0 };
    const started = Date.now();
    try {
      const sourceRow = await getOrCreateSource(supabase, source);
      if (!sourceRow.is_active) {
        result.status = "skipped";
        result.error = "Source is disabled (data_sources.is_active = false)";
      } else {
        const { fetched, articles, warnings } = await collect();
        const saved = await saveArticles(supabase, sourceRow.id, articles, collectedAt);
        Object.assign(result, { fetched, relevant: articles.length, ...saved });
        if (warnings?.length) result.warnings = warnings;
      }
    } catch (error) {
      result.status = error instanceof SourceNotConfigured ? "skipped" : "failed";
      result.error = error.message;
    }
    result.seconds = Math.round((Date.now() - started) / 100) / 10;
    results.push(result);
  }

  return results;
}

module.exports = { collectArticles, SOURCES };
