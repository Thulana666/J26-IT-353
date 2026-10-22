// Manual trigger for NLP analysis of collected articles.
//
//   npm run process:articles              up to 25 articles
//   npm run process:articles -- 200       up to 200 articles (in batches of 25)
//
// The AI service must be running (see README).

require("dotenv").config({ quiet: true });

const supabase = require("../src/config/supabase");
const { processArticles, DEFAULT_LIMIT } = require("../src/event-intel/process-articles");

async function main() {
  const total = Math.max(1, Math.floor(Number(process.argv[2])) || DEFAULT_LIMIT);
  const totals = { processed: 0, failed: 0, needsReview: 0, eventsLinked: 0 };
  for (let done = 0; done < total; ) {
    const summary = await processArticles(supabase, { limit: Math.min(DEFAULT_LIMIT, total - done) });
    for (const key of Object.keys(totals)) totals[key] += summary[key];
    for (const e of summary.errors) console.log(`  failed ${e.articleId}: ${e.error}`);
    console.log(`batch: processed ${summary.processed}, failed ${summary.failed}, review ${summary.needsReview}, linked to events ${summary.eventsLinked}`);
    if (summary.stopped) {
      console.log(`Stopped: ${summary.stopped}`);
      process.exitCode = 1;
      break;
    }
    if (summary.attempted === 0) break; // nothing left to process
    done += summary.attempted;
  }
  console.log(`\nDone: processed ${totals.processed}, failed ${totals.failed}, needs review ${totals.needsReview}, linked to events ${totals.eventsLinked}.`);
}

main().catch((error) => {
  console.error(`Processor failed: ${error.message}`);
  process.exitCode = 1;
});
