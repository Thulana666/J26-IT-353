// /api/cold-chain/issues - problems reported by drivers.
//
// PATCH /:id   admins and warehouse staff: { status: open | in_review | resolved, resolutionNotes? }
// (Drivers report issues through /api/cold-chain/driver; staff read them with
// GET /api/cold-chain/shipments/:id/issues.)

const express = require("express");
const { supabase, ISSUE_SELECT, audit } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requireWarehouseStaff } = require("../../pharmacy/auth");
const { userNames } = require("../../pharmacy/store");
const { parse, z, id, issueUpdate } = require("../validation");
const { toIssue } = require("../mappers");

const router = express.Router();

router.patch("/:id", requireWarehouseStaff, async (req, res) => {
  const { id: issueId } = parse(z.object({ id }), req.params);
  const body = parse(issueUpdate, req.body);
  const resolved = body.status === "resolved";
  const row = unwrap(
    await supabase
      .from("cold_chain_issues")
      .update({
        status: body.status,
        resolution_notes: body.resolutionNotes ?? null,
        resolved_by: resolved ? req.user.id : null,
        resolved_at: resolved ? new Date().toISOString() : null,
      })
      .eq("id", issueId)
      .select(`${ISSUE_SELECT}, pharmacy_id`)
      .maybeSingle()
  );
  if (!row) throw new HttpError(404, "Issue not found");
  await audit(req, { action: "cold_chain.issue_updated", entityType: "cold_chain_issue", entityId: row.id, pharmacyId: row.pharmacy_id, details: body });
  res.json({ issue: toIssue(row, await userNames([row.resolved_by])) });
});

module.exports = router;
