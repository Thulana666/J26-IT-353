// /api/warehouse/discrepancies - pharmacy discrepancy reports on shipments,
// handled by the warehouse through Component 4's contract function
// pharmacy_update_discrepancy() (open -> acknowledged -> resolved).
//
// GET  /                 reports (?status=open,acknowledged,resolved)
// POST /:id/acknowledge  { notes? }
// POST /:id/resolve      { notes }   how it was resolved (required)
//
// The pharmacy then settles any held stock itself (Component 4).

const express = require("express");
const { supabase, rpc } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate } = require("../validation");
const { DISCREPANCY_SELECT } = require("../../pharmacy/routes/common");
const { toDiscrepancy } = require("../../pharmacy/mappers");
const { userNames } = require("../../pharmacy/store");

const router = express.Router();
const STATUSES = ["open", "acknowledged", "resolved"];

router.get("/", async (req, res) => {
  const { status, limit } = validate(req.query, {
    status: rules.string({ max: 60 }),
    limit: rules.int({ min: 1, max: 500, default: 200 }),
  });
  const statuses = status ? status.split(",").filter(Boolean) : [];
  if (statuses.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status must be ${STATUSES.join(", ")}`);
  let query = supabase.from("shipment_discrepancies").select(DISCREPANCY_SELECT).order("reported_at", { ascending: false }).limit(limit);
  if (statuses.length) query = query.in("status", statuses);
  const rows = unwrap(await query);
  const names = await userNames(rows.flatMap((r) => [r.reported_by, r.resolved_by]));
  res.json({ discrepancies: rows.map((row) => toDiscrepancy(row, names)) });
});

for (const [action, status, notesRule] of [
  ["acknowledge", "acknowledged", rules.string({ max: 2000 })],
  ["resolve", "resolved", rules.string({ required: true, min: 3, max: 2000 })],
]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
    const { notes } = validate(req.body, { notes: notesRule });
    const row = await rpc("pharmacy_update_discrepancy", {
      p_discrepancy_id: id,
      p_user_id: req.user.id,
      p_status: status,
      p_notes: notes ?? null,
    });
    res.json({ discrepancy: { id: row.id, reportNumber: row.report_number, status: row.status } });
  });
}

module.exports = router;
