// /api/pharmacy/alerts - stock, expiry, stockout and consumption alerts.
//
// GET  /                  ?status=active (default) | resolved | all  &type=
// POST /refresh           recompute alerts from current stock and forecasts
// POST /:id/acknowledge   mark as seen (stays active until the condition clears)
// POST /:id/resolve       close manually (it re-opens if the condition persists)

const express = require("express");
const { supabase } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, pharmacyScope } = require("../auth");
const { parse, z, id } = require("../validation");
const { toAlert } = require("../mappers");
const { refreshAlerts } = require("../analytics/service");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

const TYPES = ["low_stock", "predicted_stockout", "near_expiry", "expired", "unusual_consumption"];

router.get("/", async (req, res) => {
  const { status = "active", type } = parse(
    z.object({ status: z.enum(["active", "resolved", "all"]).optional(), type: z.enum(TYPES).optional() }),
    req.query
  );
  let query = supabase
    .from("pharmacy_alerts")
    .select("*, medicine:medicines(name, strength), batch:batches(batch_number)")
    .eq("pharmacy_id", req.pharmacy.id)
    .order("created_at", { ascending: false })
    .limit(300);
  if (status === "active") query = query.neq("status", "resolved");
  if (status === "resolved") query = query.eq("status", "resolved");
  if (type) query = query.eq("alert_type", type);
  const rows = unwrap(await query);
  const rank = { critical: 0, warning: 1, info: 2 };
  rows.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.created_at < b.created_at ? 1 : -1));
  res.json({ alerts: rows.map(toAlert) });
});

router.post("/refresh", async (req, res) => {
  res.json(await refreshAlerts(req.pharmacy));
});

for (const action of ["acknowledge", "resolve"]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const { id: alertId } = parse(z.object({ id }), req.params);
    const changes =
      action === "acknowledge"
        ? { status: "acknowledged", acknowledged_by: req.user.id, acknowledged_at: new Date().toISOString() }
        : { status: "resolved", resolved_at: new Date().toISOString() };
    const row = unwrap(
      await supabase
        .from("pharmacy_alerts")
        .update(changes)
        .eq("id", alertId)
        .eq("pharmacy_id", req.pharmacy.id)
        .neq("status", "resolved")
        .select("id, status")
        .maybeSingle()
    );
    if (!row) throw new HttpError(404, "Active alert not found");
    res.json(row);
  });
}

module.exports = router;
