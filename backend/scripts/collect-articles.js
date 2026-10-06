// Manual trigger for article ingestion.
//
//   npm run collect:articles                       all sources
//   npm run collect:articles -- who daily-mirror   selected sources
//
// Uses the service-role Supabase client from backend/.env (server-side only).

require("dotenv").config({ quiet: true });

const supabase = require("../src/config/supabase");
const { collectArticles } = require("../src/ingestion/collect-articles");

async function main() {
  const only = process.argv.slice(2);
  console.log(`Collecting articles${only.length ? ` from: ${only.join(", ")}` : " from all sources"}...\n`);

  const results = await collectArticles(supabase, { only });

  for (const r of results) {
    const line =
      r.status === "ok"
        ? `fetched ${r.fetched}, relevant ${r.relevant}, new ${r.inserted}, already stored ${r.existing}`
        : r.error;
    console.log(`[${r.status.toUpperCase()}] ${r.source} (${r.seconds}s): ${line}`);
    for (const warning of r.warnings ?? []) console.log(`        warning: ${warning}`);
  }

  const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
  console.log(`\nDone: ${inserted} new article(s) saved with processing_status = pending.`);

  // Non-zero exit only when every source failed.
  if (results.every((r) => r.status === "failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Collector failed: ${error.message}`);
  process.exitCode = 1;
});
