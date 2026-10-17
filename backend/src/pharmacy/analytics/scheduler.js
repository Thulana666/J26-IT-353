// Re-runs forecasts for all active pharmacies on an interval, so forecasts,
// recommendations and alerts follow new sales and completed restocking.

const { supabase } = require("../store");
const { PHARMACY_SELECT } = require("../auth");
const { runForecast } = require("./service");

let timer = null;

async function runAll() {
  const { data: pharmacies, error } = await supabase.from("pharmacies").select(PHARMACY_SELECT).eq("is_active", true);
  if (error) {
    console.error(`[pharmacy] scheduled forecast: ${error.message}`);
    return;
  }
  for (const pharmacy of pharmacies) {
    try {
      const run = await runForecast(pharmacy, null);
      console.log(`[pharmacy] scheduled forecast for ${pharmacy.code}: ${run.engine}, ${run.product_count} products`);
    } catch (runError) {
      console.error(`[pharmacy] scheduled forecast for ${pharmacy.code} failed: ${runError.message}`);
    }
  }
}

function start(intervalHours) {
  if (timer) return;
  console.log(`[pharmacy] forecasts re-run every ${intervalHours} h`);
  timer = setInterval(runAll, intervalHours * 60 * 60 * 1000);
  timer.unref();
}

module.exports = { start, runAll };
