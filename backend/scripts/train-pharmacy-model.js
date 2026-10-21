// Trains and evaluates the pharmacy demand model and prints the report.
//
//   npm run train:pharmacy-model                  every active pharmacy
//   npm run train:pharmacy-model -- SAMPLE-PH-COL  selected pharmacy codes
//
// Read-only: nothing is written to the database. The app trains the same model
// (same code) when staff press Recalculate and stores it with that run.
// Uses the service-role Supabase client from backend/.env (server-side only).

require("dotenv").config({ quiet: true });

const supabase = require("../src/config/supabase");
const { trainDemandModel } = require("../src/pharmacy/analytics/service");

const fmt = (v, digits = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(digits));

async function main() {
  const only = process.argv.slice(2);
  let query = supabase.from("pharmacies").select("*").eq("is_active", true).order("code");
  if (only.length) query = query.in("code", only);
  const { data: pharmacies, error } = await query;
  if (error) throw error;
  const { data: medicines } = await supabase.from("medicines").select("id, name, strength");
  const name = new Map((medicines ?? []).map((m) => [m.id, [m.name, m.strength].filter(Boolean).join(" ")]));

  for (const pharmacy of pharmacies) {
    console.log(`\n=== ${pharmacy.code} (${pharmacy.name})`);
    const result = await trainDemandModel(pharmacy);
    if (result.status !== "trained") {
      console.log(`Not trained (${result.status}): ${result.reason}`);
      continue;
    }
    const m = result.model;
    console.log(`Data:     ${m.trainedOn.sample ? "SAMPLE (synthetic) history - a demonstration, not real-world accuracy" : "real POS history"}`);
    console.log(`Period:   ${m.trainedOn.from} to ${m.trainedOn.to}, ${m.trainedOn.rows} product-days usable as targets`);
    console.log(`Train:    ${m.train.from} to ${m.train.to} (${m.train.observations} observations)`);
    console.log(`Held out: ${m.test.from} to ${m.test.to} (${m.test.observations} observations), one-step-ahead, ${m.units}`);
    console.log(`Overall:  linear regression MAE ${fmt(m.metrics.linearRegression.mae)} RMSE ${fmt(m.metrics.linearRegression.rmse)} | moving average MAE ${fmt(m.metrics.movingAverage.mae)} RMSE ${fmt(m.metrics.movingAverage.rmse)}`);
    console.log(`Coefficients: ${m.features.map((f, i) => `${f} ${fmt(m.coefficients[i], 3)}`).join(", ")}`);
    console.log("Per product (MAE regression / moving average, observations, method used):");
    for (const [id, p] of Object.entries(m.perProduct)) {
      console.log(
        `  ${(name.get(id) ?? id).padEnd(34)} ${fmt(p.linearRegression.mae).padStart(7)} / ${fmt(p.movingAverage.mae).padStart(7)}  n=${String(p.observations).padStart(3)}  ${p.selected ? "linear regression" : "moving average"}`
      );
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
