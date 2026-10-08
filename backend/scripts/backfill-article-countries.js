// One-off: fill event_articles.country_code from the title for rows that
// have no country yet. Rows that already have a country are never changed.
//
//   npm run backfill:countries

require("dotenv").config({ quiet: true });

const supabase = require("../src/config/supabase");
const { findCountryCode } = require("../src/ingestion/countries");

async function main() {
  const { data: rows, error } = await supabase
    .from("event_articles")
    .select("id, title")
    .is("country_code", null);
  if (error) throw new Error(`Could not read articles: ${error.message}`);

  let updated = 0;
  for (const row of rows) {
    const code = findCountryCode(row.title);
    if (!code) continue;
    const { error: updateError } = await supabase
      .from("event_articles")
      .update({ country_code: code })
      .eq("id", row.id)
      .is("country_code", null);
    if (updateError) throw new Error(`Could not update article ${row.id}: ${updateError.message}`);
    updated++;
  }

  console.log(
    `Checked ${rows.length} article(s) without a country: filled ${updated}, ` +
      `left ${rows.length - updated} empty (no single country in the title).`
  );
}

main().catch((error) => {
  console.error(`Backfill failed: ${error.message}`);
  process.exitCode = 1;
});
