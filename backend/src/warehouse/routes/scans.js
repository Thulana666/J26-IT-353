// /api/warehouse/scans - QR scan history (lookups and pick verification).
//
// GET /   newest first (?batchId=&result=&limit=)

const express = require("express");
const { supabase, getPeopleNames } = require("../store");
const { unwrap } = require("../errors");
const { rules, validate } = require("../validation");

const router = express.Router();
const RESULTS = ["ok", "invalid", "not_found", "inactive", "batch_mismatch", "location_mismatch"];

router.get("/", async (req, res) => {
  const filters = validate(req.query, {
    batchId: rules.uuid(),
    result: rules.oneOf(RESULTS),
    limit: rules.int({ min: 1, max: 500, default: 50 }),
  });
  let query = supabase
    .from("warehouse_scan_events")
    .select("id, purpose, result, scanned_code, location_code, batch_id, storage_location_id, pick_id, message, user_id, created_at, batch:batches(batch_number)")
    .order("created_at", { ascending: false })
    .limit(filters.limit);
  if (filters.batchId) query = query.eq("batch_id", filters.batchId);
  if (filters.result) query = query.eq("result", filters.result);
  const rows = unwrap(await query);
  const people = await getPeopleNames(rows.map((row) => row.user_id));
  res.json({
    scans: rows.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      result: row.result,
      scannedCode: row.scanned_code,
      locationCode: row.location_code,
      batchId: row.batch_id,
      batchNumber: row.batch?.batch_number ?? null,
      pickId: row.pick_id,
      message: row.message,
      userName: people.get(row.user_id) ?? null,
      createdAt: row.created_at,
    })),
  });
});

module.exports = router;
