// Read-only export of event_articles into a reproducible JSON Lines snapshot
// for Component 1 NLP labelling and training. It only SELECTs rows: it never
// inserts, updates or deletes anything. Titles, text and URLs are copied
// unchanged. Credentials stay in backend/.env and are never written out.
//
//   node --use-system-ca scripts/export-article-snapshot.js [--out-dir <dir>]
//
// Writes <out-dir>/articles_<UTC timestamp>.jsonl (one article per line,
// sorted by id) and a matching .manifest.json (row count, SHA-256, fields,
// git commit). Default out-dir: ai-service/data/snapshots. The .jsonl holds
// raw article text and is git-ignored; the manifest is small and committed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXPORTER = { name: "export-article-snapshot", version: "1.0.0" };
const PAGE_SIZE = 1000;
const DEFAULT_OUT_DIR = path.join(__dirname, "..", "..", "ai-service", "data", "snapshots");
const SELECT =
  "id, data_source_id, title, summary, content, url, author, language, country_code, " +
  "published_at, fetched_at, source:data_sources(name, source_type)";
const FIELDS = [
  "id",
  "data_source_id",
  "source",
  "title",
  "summary",
  "content",
  "url",
  "author",
  "language",
  "country_code",
  "published_at",
  "fetched_at",
];

// Fixed key order so the same rows always produce the same bytes (and hash).
function toSnapshotRecord(row) {
  return {
    id: row.id,
    data_source_id: row.data_source_id ?? null,
    source: row.source ? { name: row.source.name ?? null, source_type: row.source.source_type ?? null } : null,
    title: row.title ?? null,
    summary: row.summary ?? null,
    content: row.content ?? null,
    url: row.url ?? null,
    author: row.author ?? null,
    language: row.language ?? null,
    country_code: row.country_code ?? null,
    published_at: row.published_at ?? null,
    fetched_at: row.fetched_at ?? null,
  };
}

function serializeSnapshot(rows) {
  const records = rows.map(toSnapshotRecord).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  return { records, text };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function countBySource(records) {
  const counts = {};
  for (const record of records) {
    const name = record.source?.name ?? "(unknown)";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function buildManifest({ fileName, text, records, createdAt, gitCommit }) {
  return {
    snapshot_file: fileName,
    format: "jsonl",
    created_at: createdAt,
    source_table: "event_articles",
    fields: FIELDS,
    order_by: "id",
    row_count: records.length,
    sha256: sha256(text),
    counts_by_source: countBySource(records),
    exporter: EXPORTER,
    git_commit: gitCommit,
    note: "Read-only export. Original titles, text and URLs are copied unchanged.",
  };
}

function snapshotPaths(outDir, createdAt) {
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261018T140501Z
  const base = `articles_${stamp}`;
  return {
    base,
    jsonl: path.join(outDir, `${base}.jsonl`),
    manifest: path.join(outDir, `${base}.manifest.json`),
  };
}

async function fetchAllArticles(supabase) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("event_articles")
      .select(SELECT)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read articles: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

function currentGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = { outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir" && argv[i + 1]) options.outDir = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]} (usage: --out-dir <dir>)`);
  }
  return options;
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  const supabase = require("../src/config/supabase");

  const createdAt = new Date().toISOString();
  const paths = snapshotPaths(outDir, createdAt);
  if (fs.existsSync(paths.jsonl) || fs.existsSync(paths.manifest)) {
    throw new Error(`Refusing to overwrite existing snapshot ${paths.base}`);
  }

  const { records, text } = serializeSnapshot(await fetchAllArticles(supabase));
  const manifest = buildManifest({
    fileName: path.basename(paths.jsonl),
    text,
    records,
    createdAt,
    gitCommit: currentGitCommit(),
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(paths.jsonl, text, { encoding: "utf8", flag: "wx" });
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });

  console.log(`Exported ${records.length} article(s) (read-only).`);
  console.log(`  snapshot: ${paths.jsonl}`);
  console.log(`  manifest: ${paths.manifest}`);
  console.log(`  sha256:   ${manifest.sha256}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Snapshot export failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { FIELDS, toSnapshotRecord, serializeSnapshot, buildManifest, snapshotPaths, parseArgs, sha256 };
