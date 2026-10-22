// node --test src/lib/news.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { applyNewsQuery, filterParams, parseNewsFilters, sanitizeSearch, toNewsItem } from "./news.js";

// Records the supabase-js builder calls made by applyNewsQuery.
function recorder() {
  const calls = [];
  const builder = new Proxy({}, { get: (_, method) => (...args) => (calls.push([method, ...args]), builder) });
  return { builder, calls };
}

test("filters are validated; unknown values are dropped", () => {
  const f = parseNewsFilters({ q: "dengue, (colombo)*", category: "public_health", relevance: "none", source: "x; drop", review: "yes", page: "3" });
  assert.deepEqual(f, { q: "dengue colombo", category: "public_health", relevance: null, source: null, review: "yes", page: 3 });
  assert.deepEqual(filterParams(f), { q: "dengue colombo", category: "public_health", review: "yes" });
  assert.equal(parseNewsFilters({ page: "-2" }).page, 1);
  assert.equal(sanitizeSearch("a".repeat(300)).length, 100);
});

test("default query: processed, relevant tiers only, decided 'other' excluded, newest publication first", () => {
  const { builder, calls } = recorder();
  applyNewsQuery(builder, parseNewsFilters({}));
  assert.deepEqual(calls[0], ["eq", "processing_status", "processed"]);
  assert.deepEqual(calls[1], ["in", "sri_lanka_relevance", ["direct", "indirect", "uncertain"]]);
  assert.deepEqual(calls[2], ["or", "and(or(event_category.is.null,event_category.neq.other))"]);
  const orders = calls.filter(([m]) => m === "order");
  assert.deepEqual(orders[0], ["order", "published_at", { ascending: false, nullsFirst: false }]);
  assert.deepEqual(orders[1], ["order", "fetched_at", { ascending: false }]);
  assert.deepEqual(calls.at(-1), ["range", 0, 19]);
});

test("search, category, relevance, source, review and page filters", () => {
  const { builder, calls } = recorder();
  const source = "123e4567-e89b-12d3-a456-426614174000";
  applyNewsQuery(builder, parseNewsFilters({ q: "flood", category: "natural_disaster", relevance: "direct", source, review: "no", page: "2" }));
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "sri_lanka_relevance" && c[2] === "direct"));
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "event_category" && c[2] === "natural_disaster"));
  assert.ok(calls.some((c) => c[0] === "or" && c[1] === "and(or(title.ilike.*flood*,summary.ilike.*flood*,content.ilike.*flood*))"));
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "data_source_id" && c[2] === source));
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "needs_review" && c[2] === false));
  assert.deepEqual(calls.at(-1), ["range", 20, 39]);
});

test("view model keeps publication date separate and exposes review status", () => {
  const item = toNewsItem({ id: "1", title: "T", url: "u", published_at: null, fetched_at: "2026-10-21T00:00:00Z",
    event_category: "public_health", sri_lanka_relevance: "indirect", relevance_reason: "why", needs_review: true,
    evidence: ["dengue", null], review_reasons: [{ code: "rules_review", messages: ["Check the link."] }],
    source: { name: "WHO" }, event: null });
  assert.equal(item.publishedAt, null);
  assert.equal(item.collectedAt, "2026-10-21T00:00:00Z");
  assert.deepEqual(item.evidence, ["dengue"]);
  assert.deepEqual([item.needsReview, item.reviewReasons], [true, ["Check the link."]]);
});
