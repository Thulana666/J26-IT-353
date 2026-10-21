// Re-evaluates the risk of every trip in transit every N minutes, so a
// delivery delay or a silent sensor raises its alert even when no readings
// arrive. Started by ../index.js (COLD_CHAIN_RISK_INTERVAL_MINUTES, default
// 5, 0 = off). The timer does not keep the process alive.

const supabase = require("../../config/supabase");
const { evaluateRisk } = require("./service");

let running = false;

async function runOnce(now = Date.now()) {
  if (running) return;
  running = true;
  try {
    const { data, error } = await supabase.from("cold_chain_shipments").select("shipment_id").eq("trip_status", "in_transit");
    if (error) throw error;
    for (const { shipment_id: shipmentId } of data) {
      try {
        await evaluateRisk(shipmentId, { now });
      } catch (err) {
        console.error(`[cold-chain] risk evaluation failed for ${shipmentId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[cold-chain] risk scheduler: ${err.message}`);
  } finally {
    running = false;
  }
}

function start(intervalMinutes) {
  const timer = setInterval(() => runOnce(), intervalMinutes * 60_000);
  timer.unref();
  console.log(`[cold-chain] risk re-evaluated every ${intervalMinutes} min for trips in transit`);
  return timer;
}

module.exports = { start, runOnce };
