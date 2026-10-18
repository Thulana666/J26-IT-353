// /api/warehouse/returns - returns from pharmacies, handled by the warehouse
// through Component 4's contract functions (both idempotent):
//   pharmacy_review_return()   pending -> approved | rejected (reservation released)
//   pharmacy_receive_return()  -> received: stock leaves the pharmacy; whole
//                              packs can be restocked into a warehouse location
//                              (record_inventory_movement applies the storage rules)
//
// GET  /              returns (?status=pending,approved,rejected,received)
// GET  /:id           one return with items
// POST /:id/review    { decision: "approve" | "reject", notes? }  (reject needs notes)
// POST /:id/receive   { restock?: [{ returnItemId, locationId }], notes? }

const express = require("express");
const { supabase, rpc } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError } = require("../validation");
const { todayISO } = require("../dates");
const { RETURN_SELECT } = require("../../pharmacy/routes/common");
const { toReturn } = require("../../pharmacy/mappers");
const { userNames } = require("../../pharmacy/store");

const router = express.Router();
const STATUSES = ["pending", "approved", "rejected", "received"];

const namesOf = (rows) => userNames(rows.flatMap((r) => [r.requested_by, r.reviewed_by, r.received_by]));

router.get("/", async (req, res) => {
  const { status, limit } = validate(req.query, {
    status: rules.string({ max: 60 }),
    limit: rules.int({ min: 1, max: 500, default: 200 }),
  });
  const statuses = status ? status.split(",").filter(Boolean) : [];
  if (statuses.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status must be ${STATUSES.join(", ")}`);
  let query = supabase.from("return_requests").select(RETURN_SELECT).order("requested_at", { ascending: false }).limit(limit);
  if (statuses.length) query = query.in("status", statuses);
  const rows = unwrap(await query);
  const names = await namesOf(rows);
  res.json({ returns: rows.map((row) => toReturn(row, names)) });
});

router.get("/:id", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const row = unwrap(await supabase.from("return_requests").select(RETURN_SELECT).eq("id", id).maybeSingle());
  if (!row) throw new HttpError(404, "Return not found");
  res.json({ return: toReturn(row, await namesOf([row])) });
});

router.post("/:id/review", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const body = validate(req.body, {
    decision: rules.oneOf(["approve", "reject"], { required: true }),
    notes: rules.string({ max: 1000 }),
  });
  if (body.decision === "reject" && !body.notes) throw fieldError("notes", "A reason is required to reject a return");
  const row = await rpc("pharmacy_review_return", {
    p_return_id: id,
    p_user_id: req.user.id,
    p_decision: body.decision,
    p_notes: body.notes ?? null,
  });
  res.json({ return: { id: row.id, returnNumber: row.return_number, status: row.status } });
});

router.post("/:id/receive", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const { notes } = validate(req.body, { notes: rules.string({ max: 1000 }) });
  let restock = [];
  if (req.body?.restock !== undefined && req.body.restock !== null) {
    if (!Array.isArray(req.body.restock) || req.body.restock.length > 200) throw fieldError("restock", "must be a list");
    restock = req.body.restock
      .map((line) => validate(line, { returnItemId: rules.uuid({ required: true }), locationId: rules.uuid() }))
      .filter((line) => line.locationId);
  }
  const row = await rpc("pharmacy_receive_return", {
    p_return_id: id,
    p_user_id: req.user.id,
    p_restock: restock,
    p_notes: notes ?? null,
    p_today: todayISO(),
  });
  res.json({ return: { id: row.id, returnNumber: row.return_number, status: row.status } });
});

module.exports = router;
