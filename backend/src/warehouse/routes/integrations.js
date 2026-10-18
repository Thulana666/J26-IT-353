// /api/warehouse/integrations - handoffs to other components (outbox).
//
// GET  /            events (?status=pending,failed,sent,skipped&limit=)
// POST /:id/retry   deliver a pending or failed event now (with the caller's session)

const express = require("express");
const { supabase } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate } = require("../validation");
const { toEvent, deliverEvent } = require("../integrations");

const router = express.Router();
const STATUSES = ["pending", "sent", "failed", "skipped"];

router.get("/", async (req, res) => {
  const { status, limit } = validate(req.query, {
    status: rules.string({ max: 60 }),
    limit: rules.int({ min: 1, max: 500, default: 100 }),
  });
  const statuses = status ? status.split(",").filter(Boolean) : [];
  if (statuses.some((s) => !STATUSES.includes(s))) throw new HttpError(400, `status must be ${STATUSES.join(", ")}`);
  let query = supabase
    .from("warehouse_integration_events")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (statuses.length) query = query.in("status", statuses);
  res.json({ events: unwrap(await query).map(toEvent) });
});

router.post("/:id/retry", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  res.json({ event: await deliverEvent(id, { token: req.accessToken }) });
});

module.exports = router;
