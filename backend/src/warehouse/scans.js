// QR scan history (warehouse_scan_events): lookups and pick verification.
// Logging never blocks the scan itself.

const supabase = require("../config/supabase");

async function recordScan({ purpose, result, scannedCode, locationCode, batchId, storageLocationId, pickId, message, userId }) {
  const { error } = await supabase.from("warehouse_scan_events").insert({
    purpose,
    result,
    scanned_code: typeof scannedCode === "string" ? scannedCode.trim().slice(0, 200) : null,
    location_code: typeof locationCode === "string" ? locationCode.trim().slice(0, 100) : null,
    batch_id: batchId ?? null,
    storage_location_id: storageLocationId ?? null,
    pick_id: pickId ?? null,
    message: message ?? null,
    user_id: userId ?? null,
  });
  if (error) console.error(`[warehouse] could not record scan: ${error.message}`);
}

module.exports = { recordScan };
