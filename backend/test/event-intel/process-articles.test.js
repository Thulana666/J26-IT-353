const test = require("node:test");
const assert = require("node:assert/strict");
const { processArticles, MAX_ATTEMPTS } = require("../../src/event-intel/process-articles");
const { assessRelevance, buildRequest, eventPlan, weekStart } = require("../../src/event-intel/assess");

// ---------------------------------------------------------------------------
// In-memory stand-in for the supabase-js subset the processor uses, with real
// filtering, conditional updates and unique-key upserts, so status transitions
// and de-duplication are checked against state rather than call logs.
// ---------------------------------------------------------------------------

const UNIQUE = { events: ["dedupe_key"], diseases: ["name"], locations: ["name", "location_type", "parent_id"], event_locations: ["event_id", "location_id"] };

function splitTop(text) {
  const parts = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function orPredicate(expr) {
  const clause = (c) => {
    if (c.startsWith("and(")) {
      const inner = splitTop(c.slice(4, -1)).map(clause);
      return (row) => inner.every((p) => p(row));
    }
    const [col, op, ...rest] = c.split(".");
    const value = rest.join(".");
    if (op === "eq") return (row) => String(row[col]) === value;
    if (op === "lt") return (row) => row[col] != null && (typeof row[col] === "number" ? row[col] < Number(value) : row[col] < value);
    throw new Error(`unsupported or-op ${op}`);
  };
  const parts = splitTop(expr).map(clause);
  return (row) => parts.some((p) => p(row));
}

function makeDb(tables = {}, { failOn } = {}) {
  const db = { event_articles: [], events: [], diseases: [], locations: [], event_locations: [], ...tables };
  let nextId = 1;
  const from = (table) => {
    const q = { op: "select", preds: [], payload: null, options: null, single: false, limit: null };
    const rows = () => db[table].filter((r) => q.preds.every((p) => p(r)));
    const b = {
      select() { return b; },
      insert(p) { q.op = "insert"; q.payload = p; return b; },
      update(p) { q.op = "update"; q.payload = p; return b; },
      upsert(p, o) { q.op = "upsert"; q.payload = p; q.options = o; return b; },
      eq(c, v) {
        const [col, key] = c.split("->>");
        q.preds.push((r) => (key ? r[col]?.[key] : r[c]) === v);
        return b;
      },
      gte(c, v) { q.preds.push((r) => r[c] >= v); return b; },
      lte(c, v) { q.preds.push((r) => r[c] <= v); return b; },
      is(c, v) { q.preds.push((r) => (r[c] ?? null) === v); return b; },
      lt(c, v) { q.preds.push((r) => r[c] < v); return b; },
      or(expr) { q.preds.push(orPredicate(expr)); return b; },
      order() { return b; },
      limit(n) { q.limit = n; return b; },
      maybeSingle() { q.single = true; return b; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (failOn?.(table, q)) return { data: null, error: { message: `simulated ${table} ${q.op} failure` } };
          if (q.op === "select") {
            let out = rows();
            if (table === "event_articles") out = out.map((r) => ({ ...r, source: { name: "Test source", source_type: "news" } }));
            if (q.limit != null) out = out.slice(0, q.limit);
            return { data: q.single ? out[0] ?? null : out, error: null };
          }
          if (q.op === "update") {
            const hit = rows();
            for (const r of hit) Object.assign(r, q.payload);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          }
          const keys = q.options?.onConflict?.split(",") ?? UNIQUE[table] ?? [];
          for (const row of [].concat(q.payload)) {
            const dup = keys.length && db[table].some((r) => keys.every((k) => (r[k] ?? null) === (row[k] ?? null)));
            if (dup) continue;
            db[table].push({ id: row.id ?? `${table}-${nextId++}`, ...row });
          }
          return { data: null, error: null };
        }).then(resolve, reject);
      },
    };
    return b;
  };
  return { db, client: { from } };
}

const article = (id, extra = {}) => ({
  id,
  title: "Dengue cases rise in Colombo",
  summary: null,
  content: "Health officials reported a sharp increase in dengue cases in Colombo district this week.",
  url: `https://example.org/${id}`,
  language: "en",
  country_code: "LK",
  published_at: "2026-10-14T08:00:00Z",
  fetched_at: "2026-10-14T09:00:00Z",
  processing_status: "pending",
  processing_attempts: 0,
  processing_started_at: null,
  event_id: null,
  ...extra,
});

// Mocked /event-intel/classify responses (shape of ai-service inference.classify).
function response({ category = "public_health", rulesCategory = category, relevance = "relevant", scope = "sri_lanka",
  links = [], diseases = [{ name: "dengue" }],
  lk = [{ name: "Western", type: "province" }, { name: "Colombo", type: "district", province: "Western" }],
  foreign = [], needsReview = false } = {}) {
  return {
    article_id: "x",
    rules: { category: rulesCategory, relevance, event_scope: scope, sri_lanka_links: links,
      entities: { diseases, sri_lanka_locations: lk, foreign_countries: foreign, dates: [] } },
    model: { status: "ok", predicted_category: category, confidence: 0.97, version: "seed13-test" },
    hybrid: { category, method: "model", needs_review: false },
    review: { needs_review: needsReview, reasons: needsReview ? [{ code: "rules_review", messages: ["check"] }] : [] },
    versions: { service: "1.0", rules: { name: "rules-baseline", version: "0.1.0" },
      model: { run_id: "seed13-test", checkpoint_sha256: "c700182105cc43de", seed: 13 } },
  };
}

// fetch stub: answers per article id; records calls.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answer = typeof answers === "function" ? answers(body, calls.length) : answers[body.articleId];
    if (answer instanceof Error) throw answer;
    const { status = 200, json } = answer.status ? answer : { json: answer };
    return { ok: status < 400, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date("2026-10-21T12:00:00Z");
const later = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

// ---------------------------------------------------------------------------

test("Sri Lankan public-health article: direct relevance, event + locations + disease, processed", async () => {
  const { db, client } = makeDb({ event_articles: [article("a1")] });
  const fetchImpl = fakeFetch({ a1: response() });
  const summary = await processArticles(client, { fetchImpl, now: () => NOW });

  assert.equal(summary.processed, 1);
  const a = db.event_articles[0];
  assert.equal(a.processing_status, "processed");
  assert.equal(a.sri_lanka_relevance, "direct");
  assert.equal(a.event_category, "public_health");
  assert.equal(a.needs_review, false);
  assert.equal(a.processing_attempts, 1);
  assert.match(a.analysis_version, /model seed13-test \(sha256 c700182105cc\)/);
  assert.equal(a.title, "Dengue cases rise in Colombo"); // source text untouched
  assert.equal(db.events.length, 1);
  const e = db.events[0];
  assert.equal(a.event_id, e.id);
  assert.deepEqual([e.event_type, e.scope, e.status, e.generated_by, e.severity], ["disease_outbreak", "local", "active", "nlp_pipeline", null]);
  assert.equal(db.diseases[0].name, "dengue");
  assert.equal(e.title, "Public health: Dengue – Colombo");
  assert.deepEqual(db.locations.map((l) => `${l.location_type}:${l.name}`), ["country:Sri Lanka", "province:Western", "district:Colombo"]);
  assert.equal(db.event_locations.length, 2); // Western province and Colombo district
  // Request carried the article metadata and required a real model result.
  const sent = fetchImpl.calls[0];
  assert.deepEqual([sent.articleId, sent.language, sent.countryCode, sent.sourceName, sent.requireModel], ["a1", "en", "LK", "Test source", true]);
});

test("foreign event with a plausible supply-chain link: indirect, global event, flagged for review", async () => {
  const { db, client } = makeDb({ event_articles: [article("a2", { title: "Factory shutdown in India halts API exports", country_code: "IN" })] });
  const fetchImpl = fakeFetch({
    a2: response({ category: "pharma_supply", relevance: "possibly_relevant", scope: "foreign", diseases: [], lk: [],
      foreign: [{ name: "Indian", code: "IN" }], links: [{ rule: "key_supplier_country", detail: "IN" }], needsReview: true }),
  });
  await processArticles(client, { fetchImpl, now: () => NOW });
  const a = db.event_articles[0];
  assert.equal(a.sri_lanka_relevance, "indirect");
  assert.match(a.relevance_reason, /key_supplier_country \(IN\).*not a confirmed impact/);
  assert.equal(a.needs_review, true);
  const e = db.events[0];
  assert.deepEqual([e.event_type, e.scope, e.status, e.needs_review], ["supply_disruption", "global", "monitoring", true]);
  assert.deepEqual(db.locations.map((l) => l.name), ["India"]);
});

test("unrelated international event: no Sri Lankan connection, no event, no review", async () => {
  const { db, client } = makeDb({ event_articles: [article("a3", { title: "Election results announced in Mexico", country_code: "MX" })] });
  await processArticles(client, {
    fetchImpl: fakeFetch({ a3: response({ category: "other", relevance: "not_relevant", scope: "foreign", diseases: [], lk: [], foreign: [{ name: "Mexico", code: "MX" }] }) }),
    now: () => NOW,
  });
  const a = db.event_articles[0];
  assert.deepEqual([a.processing_status, a.sri_lanka_relevance, a.needs_review, a.event_id], ["processed", "none", false, null]);
  assert.equal(db.events.length, 0);
});

test("foreign natural disaster without a link is not relevant just because it is a disaster", () => {
  const r = response({ category: "natural_disaster", relevance: "not_relevant", scope: "foreign", diseases: [], lk: [] });
  assert.equal(assessRelevance(r).relevance, "none");
  assert.equal(eventPlan(article("x"), r, assessRelevance(r)), null);
});

test("insufficient text, uncertain relevance, empty and non-English articles are flagged for review", async () => {
  const { db, client } = makeDb({
    event_articles: [
      article("s1", { content: null, title: "Alert" }),
      article("s2", { title: " ", content: null, summary: null }),
      article("s3", { language: "si", title: "ඩෙංගු" }),
    ],
  });
  const fetchImpl = fakeFetch({ s1: response({ category: "other", relevance: "insufficient_evidence", diseases: [], lk: [] }) });
  await processArticles(client, { fetchImpl, now: () => NOW });
  assert.equal(fetchImpl.calls.length, 1); // s2 and s3 are never sent
  for (const a of db.event_articles) {
    assert.deepEqual([a.processing_status, a.sri_lanka_relevance, a.needs_review], ["processed", "uncertain", true], a.id);
  }
  assert.match(db.event_articles[2].relevance_reason, /not supported/);
  assert.equal(db.events.length, 0);
});

test("model sees an event the rules did not: uncertain, never direct", () => {
  const r = response({ category: "public_health", rulesCategory: "other", relevance: "not_relevant" });
  assert.equal(assessRelevance(r).relevance, "uncertain");
  const r2 = response({ category: "other", rulesCategory: "public_health", relevance: "relevant" });
  assert.equal(assessRelevance(r2).relevance, "uncertain");
});

test("service unreachable or no model: run stops, article released without using an attempt", async () => {
  for (const answer of [new TypeError("fetch failed"), { status: 501, json: { detail: { reason: "not_configured" } } }]) {
    const { db, client } = makeDb({ event_articles: [article("f1"), article("f2")] });
    const fetchImpl = fakeFetch(() => answer);
    const summary = await processArticles(client, { fetchImpl, now: () => NOW });
    assert.ok(summary.stopped);
    assert.equal(fetchImpl.calls.length, 1); // second article not tried
    assert.deepEqual([db.event_articles[0].processing_status, db.event_articles[0].processing_attempts], ["pending", 0]);
  }
});

test("service errors are retried a bounded number of times, after a wait", async () => {
  const { db, client } = makeDb({ event_articles: [article("r1")] });
  const fetchImpl = fakeFetch(() => ({ status: 500, json: { detail: "boom" } }));
  await processArticles(client, { fetchImpl, now: () => NOW });
  const a = db.event_articles[0];
  assert.deepEqual([a.processing_status, a.processing_attempts], ["failed", 1]);
  assert.match(a.processing_error, /attempt 1 of 3/);

  await processArticles(client, { fetchImpl, now: () => later(1) }); // too soon: not retried
  assert.equal(fetchImpl.calls.length, 1);

  await processArticles(client, { fetchImpl, now: () => later(10) });
  await processArticles(client, { fetchImpl, now: () => later(20) });
  await processArticles(client, { fetchImpl, now: () => later(30) }); // attempts exhausted
  assert.equal(fetchImpl.calls.length, MAX_ATTEMPTS);
  assert.deepEqual([a.processing_status, a.processing_attempts], ["failed", MAX_ATTEMPTS]);
});

test("a retry after a transient failure succeeds; a 422 is not retried", async () => {
  const { db, client } = makeDb({ event_articles: [article("t1"), article("t2")] });
  let first = true;
  const fetchImpl = fakeFetch((body) => {
    if (body.articleId === "t2") return { status: 422, json: { detail: "bad input" } };
    if (first) { first = false; return { status: 503, json: { detail: "busy" } }; }
    return response();
  });
  await processArticles(client, { fetchImpl, now: () => NOW });
  await processArticles(client, { fetchImpl, now: () => later(10) });
  const [t1, t2] = db.event_articles;
  assert.deepEqual([t1.processing_status, t1.processing_error, t1.processing_attempts], ["processed", null, 2]);
  assert.deepEqual([t2.processing_status, t2.processing_attempts], ["failed", MAX_ATTEMPTS]);
  assert.match(t2.processing_error, /not retried/);
});

test("related articles and re-runs never duplicate events, links or locations", async () => {
  const { db, client } = makeDb({ event_articles: [article("d1"), article("d2", { published_at: "2026-10-16T08:00:00Z" })] });
  const fetchImpl = fakeFetch(() => response());
  await processArticles(client, { fetchImpl, now: () => NOW });
  await processArticles(client, { fetchImpl, now: () => later(60) }); // nothing pending any more
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(db.events.length, 1);
  assert.equal(db.event_articles[0].event_id, db.event_articles[1].event_id);
  assert.equal(db.event_locations.length, 2);
  assert.equal(db.locations.length, 3);
  assert.equal(db.diseases.length, 1);
});

test("an ongoing outbreak reported over several weeks stays one event; a later wave is a new one", async () => {
  const { db, client } = makeDb({
    event_articles: [
      article("w1", { published_at: "2026-05-04T08:00:00Z" }),
      article("w2", { published_at: "2026-05-25T08:00:00Z" }), // 3 weeks later: same event
      article("w3", { published_at: "2026-08-03T08:00:00Z" }), // 3 months later: new event
    ],
  });
  await processArticles(client, { fetchImpl: fakeFetch(() => response()), now: () => NOW });
  assert.equal(db.events.length, 2);
  const [w1, w2, w3] = db.event_articles;
  assert.equal(w1.event_id, w2.event_id);
  assert.notEqual(w1.event_id, w3.event_id);
});

test("an event starts at its earliest article even when a later one is processed first", async () => {
  const { db, client } = makeDb({ event_articles: [
    article("late", { published_at: "2026-05-25T08:00:00Z" }), article("early", { published_at: "2026-05-04T08:00:00Z" }),
  ] });
  await processArticles(client, { fetchImpl: fakeFetch(() => response()), now: () => NOW });
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].started_at, "2026-05-04");
});

test("a global report is not placed in the first country its text names", async () => {
  const { db, client } = makeDb({ event_articles: [article("g1", { title: "Mpox – Global situation" })] });
  await processArticles(client, {
    fetchImpl: fakeFetch(() => response({ relevance: "possibly_relevant", scope: "global", lk: [], diseases: [{ name: "mpox" }],
      foreign: [{ name: "Italy", code: "IT" }], links: [{ rule: "global_scope", detail: "global or multi-country event" }], needsReview: true })),
    now: () => NOW,
  });
  assert.equal(db.events[0].title, "Public health: Mpox – Multi-country");
  // (lk is empty here; see the next test for a foreign report that mentions Sri Lanka)
  assert.equal(db.locations.length, 0);
});

test("a foreign report that mentions Sri Lanka is not located in Sri Lanka", async () => {
  const { db, client } = makeDb({ event_articles: [article("m2", { title: "Seasonal influenza – Global situation" })] });
  await processArticles(client, {
    fetchImpl: fakeFetch(() => response({ relevance: "possibly_relevant", scope: "global", diseases: [{ name: "influenza" }],
      lk: [{ name: "Sri Lanka", type: "country" }], links: [{ rule: "mentions_sri_lanka", detail: "Sri Lanka" }], needsReview: true })),
    now: () => NOW,
  });
  assert.equal(db.event_articles[0].sri_lanka_relevance, "indirect");
  assert.equal(db.locations.length, 0);
});

const disaster = (hazard, extra = {}) => response({ category: "natural_disaster", diseases: [],
  lk: [{ name: "Sri Lanka", type: "country" }], ...extra });
function withHazard(r, term) {
  r.rules.matched_keywords = { natural_disaster: [{ term, field: "title" }, { term: "GDACS event type: Flood", field: "structured" }] };
  return r;
}

test("GDACS alerts group by alert id: episodes merge, different alerts and hazards never do", async () => {
  const gdacs = (id, type, published_at) => article(`${type}${id}-${published_at}`, {
    title: `${type === "FL" ? "Flood" : "Tropical Cyclone"} in Sri Lanka`, url: `https://www.gdacs.org/report.aspx?eventid=${id}&eventtype=${type}`, published_at });
  const { db, client } = makeDb({ event_articles: [
    gdacs(1000, "FL", "2020-12-01T00:00:00Z"), gdacs(1000, "FL", "2020-12-20T00:00:00Z"), // same alert, two episodes
    gdacs(2000, "TC", "2020-12-02T00:00:00Z"),                                          // cyclone the same week
    gdacs(3000, "FL", "2020-12-03T00:00:00Z"),                                          // another flood alert
  ] });
  const fetchImpl = fakeFetch((body) => withHazard(disaster(), body.title.startsWith("Flood") ? "flood" : "cyclone / storm"));
  await processArticles(client, { fetchImpl, now: () => NOW });
  assert.equal(db.events.length, 3);
  const [a, b, c, d] = db.event_articles;
  assert.equal(a.event_id, b.event_id);
  assert.equal(new Set([a.event_id, c.event_id, d.event_id]).size, 3);
  assert.equal(db.events.find((e) => e.id === c.event_id).title, "Natural disaster: Cyclone – Sri Lanka");
  assert.equal(db.events.find((e) => e.id === a.event_id).analysis.alert_id, "FL-1000");
});

test("non-GDACS disasters group by hazard + place; floods and landslides stay apart", async () => {
  const { db, client } = makeDb({ event_articles: [
    article("n1", { title: "Floods in Ratnapura" }), article("n2", { title: "More floods in Ratnapura", published_at: "2026-10-20T08:00:00Z" }),
    article("n3", { title: "Landslide in Ratnapura" }),
  ] });
  const fetchImpl = fakeFetch((body) => withHazard(disaster("x", { lk: [{ name: "Ratnapura", type: "district", province: "Sabaragamuwa" }] }),
    body.title.includes("Landslide") ? "landslide" : "flood"));
  await processArticles(client, { fetchImpl, now: () => NOW });
  const [n1, n2, n3] = db.event_articles;
  assert.equal(n1.event_id, n2.event_id);
  assert.notEqual(n1.event_id, n3.event_id);
});

test("the same disease in different countries is not merged", async () => {
  const { db, client } = makeDb({ event_articles: [article("c1", { title: "Nipah - Bangladesh" }), article("c2", { title: "Nipah - India" })] });
  const fetchImpl = fakeFetch((body) => response({ relevance: "possibly_relevant", scope: "foreign", diseases: [{ name: "nipah virus" }], lk: [],
    foreign: [body.title.endsWith("India") ? { name: "Indian", code: "IN" } : { name: "Bangladesh", code: "BD" }],
    links: [{ rule: "neighbouring_country", detail: "x" }], needsReview: true }));
  await processArticles(client, { fetchImpl, now: () => NOW });
  assert.equal(db.events.length, 2);
  assert.deepEqual(db.events.map((e) => e.title).sort(), ["Public health: Nipah virus – Bangladesh", "Public health: Nipah virus – India"]);
});

test("weak identity (no disease, rules-only supply category) gives standalone events that never merge", async () => {
  const { db, client } = makeDb({ event_articles: [article("u1"), article("u2")] });
  const fetchImpl = fakeFetch(() => response({ category: "pharma_supply", relevance: "possibly_relevant", scope: "foreign", diseases: [], lk: [],
    foreign: [{ name: "Indian", code: "IN" }], links: [{ rule: "key_supplier_country", detail: "IN" }], needsReview: true }));
  await processArticles(client, { fetchImpl, now: () => NOW });
  assert.equal(db.events.length, 2);
  assert.ok(db.events.every((e) => e.analysis.standalone && e.needs_review));
});

test("an article claimed by another run is skipped", async () => {
  const { db, client } = makeDb({ event_articles: [article("c1")] });
  const original = client.from;
  // Another worker claims c1 between the candidate read and our claim.
  client.from = (table) => {
    const b = original(table);
    const update = b.update;
    b.update = (payload) => {
      if (payload.processing_status === "processing") Object.assign(db.event_articles[0], { processing_status: "processing", processing_attempts: 1 });
      return update(payload);
    };
    return b;
  };
  const fetchImpl = fakeFetch(() => response());
  const summary = await processArticles(client, { fetchImpl, now: () => NOW });
  assert.equal(summary.attempted, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test("a stale 'processing' claim from a crashed run is reclaimed", async () => {
  const { db, client } = makeDb({ event_articles: [article("p1", { processing_status: "processing", processing_attempts: 1, processing_started_at: "2026-10-21T11:00:00.000Z" })] });
  await processArticles(client, { fetchImpl: fakeFetch(() => response()), now: () => NOW });
  assert.deepEqual([db.event_articles[0].processing_status, db.event_articles[0].processing_attempts], ["processed", 2]);
});

test("a persistence failure leaves the article failed, never processed", async () => {
  const { db, client } = makeDb({ event_articles: [article("w1")] }, { failOn: (table, q) => table === "events" && q.op === "upsert" });
  const summary = await processArticles(client, { fetchImpl: fakeFetch(() => response()), now: () => NOW });
  assert.equal(summary.failed, 1);
  const a = db.event_articles[0];
  assert.equal(a.processing_status, "failed");
  assert.match(a.processing_error, /simulated events upsert failure/);
  assert.equal(a.analysis, undefined);
});

test("missing migration stops before any article is touched", async () => {
  const { db, client } = makeDb({ event_articles: [article("m1")] }, { failOn: (table, q) => table === "event_articles" && q.op === "select" });
  await assert.rejects(processArticles(client, { fetchImpl: fakeFetch(() => response()), now: () => NOW }), /20261021000000_add_article_analysis_fields/);
  assert.equal(db.event_articles[0].processing_status, "pending");
});

test("request clipping and week grouping", () => {
  const req = buildRequest(article("x", { content: "a".repeat(150_000) }));
  assert.equal(req.content.length, 100_000);
  assert.equal(weekStart("2026-10-14T08:00:00Z"), "2026-10-12");
  assert.equal(weekStart("2026-10-18T23:00:00Z"), "2026-10-12");
  assert.equal(weekStart("nonsense"), null);
});
