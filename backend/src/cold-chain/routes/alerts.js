// /api/cold-chain/alerts
//
// POST /:id/acknowledge   staff who can see the shipment: mark an open alert as
//                         seen. It stays active until the condition is over;
//                         repeating the call changes nothing.

const express = require("express");
const { supabase, ALERT_SELECT } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requireAnyStaff, assertCanSee } = require("../../pharmacy/auth");
const { userNames } = require("../../pharmacy/store");
const { parse, z, id } = require("../validation");
const { toAlert } = require("../mappers");

const router = express.Router();

router.post("/:id/acknowledge", requireAnyStaff, async (req, res) => {
  const { id: alertId } = parse(z.object({ id }), req.params);
  const alert = unwrap(await supabase.from("cold_chain_alerts").select(ALERT_SELECT).eq("id", alertId).maybeSingle());
  if (!alert) throw new HttpError(404, "Alert not found");
  assertCanSee(req, alert.pharmacy_id, "Alert");

  let row = alert;
  if (alert.status === "open") {
    const updated = unwrap(
      await supabase
        .from("cold_chain_alerts")
        .update({ status: "acknowledged", acknowledged_by: req.user.id, acknowledged_at: new Date().toISOString() })
        .eq("id", alertId)
        .eq("status", "open")
        .select(ALERT_SELECT)
        .maybeSingle()
    );
    row = updated ?? alert;
  }
  const names = await userNames([row.acknowledged_by]);
  res.json({ alert: toAlert(row, names) });
});

module.exports = router;
