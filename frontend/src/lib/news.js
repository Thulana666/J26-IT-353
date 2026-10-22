// Filters, sorting and paging for the Recent News page.
// No Next.js imports here so the tests can run with plain node.

export const NEWS_PER_PAGE = 20;

// Relevance shown on the page; "none" (no Sri Lankan connection) is never listed.
export const NEWS_RELEVANCE = ["direct", "indirect", "uncertain"];
// Plain-language relevance labels, shared by the page (server) and the list (client).
export const NEWS_RELEVANCE_LABELS = {
  direct: "In Sri Lanka",
  indirect: "Possible link to Sri Lanka",
  uncertain: "Unclear connection",
};
export const NEWS_CATEGORIES = ["public_health", "natural_disaster", "pharma_supply", "logistics", "geopolitical_trade"];

// Characters with meaning in PostgREST filter strings are dropped from searches.
export function sanitizeSearch(value) {
  return String(value ?? "")
    .replace(/[,()*%\\:"'.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

const pick = (value, allowed) => (allowed.includes(value) ? value : null);
const first = (value) => (Array.isArray(value) ? value[0] : value);

// searchParams (Next.js) -> validated filters. Unknown values are ignored, not trusted.
export function parseNewsFilters(params = {}) {
  const page = Math.max(1, Math.floor(Number(first(params.page))) || 1);
  const source = first(params.source);
  return {
    q: sanitizeSearch(first(params.q)),
    category: pick(first(params.category), NEWS_CATEGORIES),
    relevance: pick(first(params.relevance), NEWS_RELEVANCE),
    source: /^[0-9a-f-]{36}$/i.test(source ?? "") ? source : null,
    review: pick(first(params.review), ["yes", "no"]),
    page,
  };
}

// Filters as URL params (for pagination links and "clear" checks); page excluded.
export function filterParams(filters) {
  const out = {};
  for (const key of ["q", "category", "relevance", "source", "review"]) if (filters[key]) out[key] = filters[key];
  return out;
}

export const NEWS_COLUMNS = `id, title, url, published_at, fetched_at, processed_at, event_category,
  sri_lanka_relevance, relevance_reason, needs_review, analysis_version,
  evidence:analysis->hybrid->evidence, review_reasons:analysis->review->reasons,
  source:data_sources (id, name, source_type),
  event:events (id, title)`;

// Applies the page's filters, ordering and range to a supabase-js select builder.
export function applyNewsQuery(query, filters, pageSize = NEWS_PER_PAGE) {
  query = query.eq("processing_status", "processed");
  query = filters.relevance ? query.eq("sri_lanka_relevance", filters.relevance) : query.in("sri_lanka_relevance", NEWS_RELEVANCE);

  // Hide articles classified as "other". Unclassified ones (e.g. non-English) still show.
  const categoryClause = filters.category ? null : "or(event_category.is.null,event_category.neq.other)";
  if (filters.category) query = query.eq("event_category", filters.category);
  const searchClause = filters.q
    ? `or(title.ilike.*${filters.q}*,summary.ilike.*${filters.q}*,content.ilike.*${filters.q}*)`
    : null;
  const clauses = [categoryClause, searchClause].filter(Boolean);
  if (clauses.length) query = query.or(`and(${clauses.join(",")})`);

  if (filters.source) query = query.eq("data_source_id", filters.source);
  if (filters.review === "yes") query = query.eq("needs_review", true);
  if (filters.review === "no") query = query.eq("needs_review", false);

  // Newest first. Articles without a publish date go at the end.
  const from = (filters.page - 1) * pageSize;
  return query
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("fetched_at", { ascending: false })
    .order("id")
    .range(from, from + pageSize - 1);
}

// Row -> view model. Publication date stays separate from collection time.
export function toNewsItem(row) {
  const reasons = (row.review_reasons ?? []).flatMap((r) => r.messages ?? []).slice(0, 3);
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    source: row.source?.name ?? "Unknown source",
    publishedAt: row.published_at ?? null,
    collectedAt: row.fetched_at,
    category: row.event_category,
    relevance: row.sri_lanka_relevance,
    reason: row.relevance_reason,
    evidence: Array.isArray(row.evidence) ? row.evidence.filter(Boolean).slice(0, 5) : [],
    needsReview: Boolean(row.needs_review),
    reviewReasons: reasons,
    event: row.event ? { id: row.event.id, title: row.event.title } : null,
  };
}
