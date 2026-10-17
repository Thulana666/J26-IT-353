// /api/pharmacy/discrepancies - shipment discrepancy reports (shared with the
// warehouse application, which acknowledges and resolves them in the same
// shipment_discrepancies table).
//
// GET  /           reports the user may see (?status=open,acknowledged&shipmentId=&medicineId=)
// POST /           pharmacy: report a disputed item (or an unknown item) of a shipment.
//                  The expected quantity of a shipment item is taken from the shipment.
//                  A repeated clientRequestId returns the first report. A report on an
//                  item already in stock holds its disputed units (not sellable).
// POST /:id/hold   pharmacy: after the warehouse resolved the report, release the held
//                  units to available stock or write them off ({ outcome }); idempotent.

const express = require("express");
const { supabase, rpc, userNames } = require("../store");
const { unwrap } = require("../errors");
const { requirePharmacyStaff, requireAnyStaff, pharmacyScope } = require("../auth");
const { parse, z, id, int, text, optional } = require("../validation");
const { toDiscrepancy } = require("../mappers");
const { refreshAlertsQuietly } = require("../analytics/service");
const { DISCREPANCY_SELECT, scopeToVisible, parseList, attachHolds } = require("./common");

const router = express.Router();

const STATUSES = ["open", "acknowledged", "resolved"];
const TYPES = ["missing", "excess", "damaged", "incorrect_item", "incorrect_batch", "expired", "other"];

const namesOf = (rows) => userNames(rows.flatMap((r) => [r.reported_by, r.resolved_by]));

router.get("/", requireAnyStaff, async (req, res) => {
  const { statuses, limit } = parseList(req, STATUSES);
  const filters = parse(z.object({ shipmentId: optional(id), medicineId: optional(id) }), req.query);
  let query = supabase.from("shipment_discrepancies").select(DISCREPANCY_SELECT).order("reported_at", { ascending: false }).limit(limit);
  query = scopeToVisible(query, req);
  if (statuses.length) query = query.in("status", statuses);
  if (filters.shipmentId) query = query.eq("shipment_id", filters.shipmentId);
  if (filters.medicineId) query = query.eq("medicine_id", filters.medicineId);
  const rows = unwrap(await query);
  const names = await namesOf(rows);
  res.json({ discrepancies: (await attachHolds(rows)).map((row) => toDiscrepancy(row, names)) });
});

const reportBody = z.object({
  clientRequestId: id,
  shipmentId: id,
  shipmentItemId: optional(id),
  medicineId: optional(id),
  type: z.enum(TYPES),
  observedQuantity: optional(int(0, 100_000)),
  notes: text(2000),
  barcode: text(128),
  batchNumber: text(80),
});

router.post("/", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const body = parse(reportBody, req.body);
  const row = await rpc("pharmacy_report_discrepancy", {
    p_shipment_id: body.shipmentId,
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_type: body.type,
    p_shipment_item_id: body.shipmentItemId ?? null,
    p_observed: body.observedQuantity ?? null,
    p_notes: body.notes ?? null,
    p_barcode: body.barcode ?? null,
    p_batch_number: body.batchNumber ?? null,
    p_medicine_id: body.medicineId ?? null,
    p_client_request_id: body.clientRequestId,
  });
  if (row.held_units > 0) refreshAlertsQuietly(req.pharmacy);
  res.status(row.duplicate ? 200 : 201).json({
    id: row.id,
    reportNumber: row.report_number,
    duplicate: row.duplicate,
    expectedQuantity: row.expected_quantity,
    observedQuantity: row.actual_quantity,
    type: row.discrepancy_type,
    heldUnits: row.held_units ?? 0,
  });
});

const holdBody = z.object({ outcome: z.enum(["release", "write_off"]), notes: text(500) });

router.post("/:id/hold", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const { id: discrepancyId } = parse(z.object({ id }), req.params);
  const body = parse(holdBody, req.body);
  const result = await rpc("pharmacy_settle_discrepancy_hold", {
    p_discrepancy_id: discrepancyId,
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_outcome: body.outcome,
    p_notes: body.notes ?? null,
  });
  if (!result.already_processed) refreshAlertsQuietly(req.pharmacy);
  res.json({ result: { alreadyProcessed: result.already_processed, outcome: result.outcome, units: result.units } });
});

module.exports = router;
