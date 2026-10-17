// /api/pharmacy/returns - returns from a pharmacy to its warehouse.
//
// GET  /                  requests the user may see (?status=&scope=all)
// GET  /:id               one request
// POST /                  pharmacy: request a return (status pending; the quantity is held,
//                         not deducted)
//
// The warehouse application reviews and receives returns in the shared tables
// with pharmacy_review_return() / pharmacy_receive_return(); stock leaves the
// pharmacy only when the warehouse confirms receipt (idempotent).

const express = require("express");
const { supabase, rpc, userNames } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, requireAnyStaff, pharmacyScope, assertCanSee } = require("../auth");
const { parse, z, id, int, text } = require("../validation");
const { toReturn } = require("../mappers");
const { refreshAlertsQuietly } = require("../analytics/service");
const { RETURN_SELECT, scopeToVisible, parseList } = require("./common");

const router = express.Router();

const STATUSES = ["pending", "approved", "rejected", "received"];
const REASONS = ["expired", "near_expiry", "damaged", "recalled", "overstock", "incorrect_item", "other"];

async function loadReturn(req, returnId) {
  const row = unwrap(await supabase.from("return_requests").select(RETURN_SELECT).eq("id", returnId).maybeSingle());
  if (!row) throw new HttpError(404, "Return request not found");
  assertCanSee(req, row.pharmacy_id, "Return request");
  return row;
}

const namesOf = (rows) => userNames(rows.flatMap((r) => [r.requested_by, r.reviewed_by, r.received_by]));

router.get("/", requireAnyStaff, async (req, res) => {
  const { statuses, limit } = parseList(req, STATUSES);
  let query = supabase.from("return_requests").select(RETURN_SELECT).order("requested_at", { ascending: false }).limit(limit);
  query = scopeToVisible(query, req);
  if (statuses.length) query = query.in("status", statuses);
  const rows = unwrap(await query);
  const names = await namesOf(rows);
  res.json({ returns: rows.map((row) => toReturn(row, names)) });
});

router.get("/:id", requireAnyStaff, async (req, res) => {
  const { id: returnId } = parse(z.object({ id }), req.params);
  const row = await loadReturn(req, returnId);
  res.json({ return: toReturn(row, await namesOf([row])) });
});

const createBody = z.object({
  items: z
    .array(z.object({ inventoryId: id, quantity: int(1, 100_000), reason: z.enum(REASONS), notes: text(500) }))
    .min(1, "add at least one item")
    .max(100),
  notes: text(1000),
});

router.post("/", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const body = parse(createBody, req.body);
  const row = await rpc("pharmacy_create_return", {
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_items: body.items,
    p_notes: body.notes ?? null,
  });
  refreshAlertsQuietly(req.pharmacy);
  res.status(201).json({ id: row.id, returnNumber: row.return_number });
});

module.exports = router;
