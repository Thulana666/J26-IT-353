const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  FIELDS,
  toSnapshotRecord,
  serializeSnapshot,
  buildManifest,
  snapshotPaths,
  parseArgs,
  sha256,
} = require("../../scripts/export-article-snapshot");

const row = (id, extra = {}) => ({
  id,
  data_source_id: "src-1",
  title: "Dengue cases rise in Colombo",
  summary: null,
  content: "Line one\nLine two – with “quotes” and සිංහල text.",
  url: `https://example.org/${id}?a=1&b=2`,
  author: null,
  language: "en",
  country_code: "LK",
  published_at: "2026-10-08T00:00:00+00:00",
  fetched_at: "2026-10-09T00:00:00+00:00",
  processing_status: "pending",
  relevance: 0.9,
  source: { name: "Daily News (Sri Lanka)", source_type: "news" },
  ...extra,
});

test("snapshot records keep original text and URLs unchanged", () => {
  const original = row("b");
  const record = toSnapshotRecord(original);
  assert.equal(record.title, original.title);
  assert.equal(record.content, original.content);
  assert.equal(record.url, original.url);
  assert.deepEqual(Object.keys(record), FIELDS);
});

test("processing fields and stored relevance values are not exported", () => {
  const record = toSnapshotRecord(row("a"));
  assert.equal("processing_status" in record, false);
  assert.equal("relevance" in record, false);
});

test("serialisation is sorted by id and byte-for-byte reproducible", () => {
  const first = serializeSnapshot([row("c"), row("a"), row("b")]);
  const second = serializeSnapshot([row("b"), row("c"), row("a")]);
  assert.deepEqual(first.records.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(first.text, second.text);
  assert.equal(first.text.split("\n").filter(Boolean).length, 3);
  assert.equal(JSON.parse(first.text.split("\n")[0]).content, row("a").content);
});

test("manifest records hash and counts but no credentials", () => {
  process.env.SUPABASE_URL = "https://secret-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_should_never_appear";
  const { records, text } = serializeSnapshot([row("a"), row("b", { source: null })]);
  const manifest = buildManifest({
    fileName: "articles_x.jsonl",
    text,
    records,
    createdAt: "2026-10-18T00:00:00.000Z",
    gitCommit: "abc123",
  });
  assert.equal(manifest.row_count, 2);
  assert.equal(manifest.sha256, sha256(text));
  assert.deepEqual(manifest.counts_by_source, { "(unknown)": 1, "Daily News (Sri Lanka)": 1 });
  const json = JSON.stringify(manifest);
  assert.equal(json.includes("secret-project"), false);
  assert.equal(json.includes("sb_secret"), false);
});

test("snapshot file names use a UTC timestamp", () => {
  const paths = snapshotPaths("/tmp/out", "2026-10-18T14:05:01.123Z");
  assert.equal(paths.base, "articles_20261018T140501Z");
  assert.equal(path.basename(paths.manifest), "articles_20261018T140501Z.manifest.json");
});

test("unknown arguments are rejected", () => {
  assert.throws(() => parseArgs(["--delete"]), /Unknown argument/);
  assert.equal(parseArgs(["--out-dir", "x"]).outDir, path.resolve("x"));
});
