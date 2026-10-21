// /api/pharmacy/recommendations - reorder recommendations (Q*) and decisions.
//
// GET  /              ?status=pending (default) | accepted | edited | rejected | all
// POST /:id/reject    record a rejection with a reason
//
// Accepting or editing happens when an order is submitted with the
// recommendation's id (pharmacy_create_order records the decision).

const express = require("express");
const { supabase, rpc, userNames } = require("../store");
const { unwrap } = require("../errors");
const { requirePharmacyStaff, pharmacyScope } = require("../auth");
const { parse, z, id, text } = require("../validation");
const { toRecommendation } = require("../mappers");
const { PRODUCT } = require("./common");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

const STATUSES = ["pending", "accepted", "edited", "rejected", "superseded"];

router.get("/", async (req, res) => {
  const { status = "pending" } = parse(z.object({ status: z.enum([...STATUSES, "all", "decided"]).optional() }), req.query);
  let query = supabase.from("reorder_recommendations").select(`*, ${PRODUCT}`).eq("pharmacy_id", req.pharmacy.id).order("generated_at", { ascending: false }).limit(200);
  if (status === "decided") query = query.in("status", ["accepted", "edited", "rejected"]);
  else if (status !== "all") query = query.eq("status", status);
  const rows = unwrap(await query);
  const names = await userNames(rows.map((r) => r.decided_by));
  res.json({ recommendations: rows.map((row) => toRecommendation(row, names)) });
});

router.post("/:id/reject", async (req, res) => {
  const { id: recommendationId } = parse(z.object({ id }), req.params);
  const { notes } = parse(z.object({ notes: text(500) }), req.body);
  const row = await rpc("pharmacy_reject_recommendation", {
    p_recommendation_id: recommendationId,
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_notes: notes ?? null,
  });
  res.json({ id: row.id, status: row.status });
});

module.exports = router;
