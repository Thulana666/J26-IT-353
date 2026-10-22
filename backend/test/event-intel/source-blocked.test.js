const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchWithTimeout, SourceUnavailable } = require("../../src/ingestion/normalize");

const respond = (status, headers = {}) => async () => new Response("blocked", { status, headers });

test("a publisher's bot-protection challenge is reported as unavailable, not as a failure", async (t) => {
  t.mock.method(globalThis, "fetch", respond(403, { "cf-mitigated": "challenge" }));
  await assert.rejects(fetchWithTimeout("https://www.dailynews.lk/feed/"), (e) => e instanceof SourceUnavailable && /blocks automated access/.test(e.message));
});

test("any other HTTP error still fails", async (t) => {
  t.mock.method(globalThis, "fetch", respond(403));
  await assert.rejects(fetchWithTimeout("https://example.org/feed/"), (e) => !(e instanceof SourceUnavailable) && /HTTP 403/.test(e.message));
});

test("an RSS source whose only feed is blocked is skipped by the collector", async (t) => {
  t.mock.method(globalThis, "fetch", respond(403, { "cf-mitigated": "challenge" }));
  const { createRssSource } = require("../../src/ingestion/sources/rss-source");
  const src = createRssSource({ source: { name: "X" }, feeds: [{ url: "https://www.dailynews.lk/feed/" }], filter: true });
  await assert.rejects(src.collect(), SourceUnavailable);
});
