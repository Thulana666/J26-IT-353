// GET /api/pharmacy/context - the signed-in user's role and the pharmacies
// they can work with (drives the dashboard navigation and pharmacy switcher).

const express = require("express");
const { supabase } = require("../store");
const { unwrap } = require("../errors");
const { PHARMACY_SELECT } = require("../auth");
const { toPharmacy } = require("../mappers");
const { UUID_RE } = require("../../warehouse/validation");

const router = express.Router();

router.get("/", async (req, res) => {
  const { user } = req;
  let pharmacies = [];
  if (user.isAdmin || user.isWarehouseStaff) {
    pharmacies = unwrap(await supabase.from("pharmacies").select(PHARMACY_SELECT).order("name"));
  } else if (user.isPharmacyStaff && user.pharmacyId) {
    pharmacies = unwrap(await supabase.from("pharmacies").select(PHARMACY_SELECT).eq("id", user.pharmacyId));
  }

  let current = null;
  if (user.isPharmacyStaff) {
    current = pharmacies[0] ?? null;
  } else if (user.isAdmin) {
    const requested = req.get("x-pharmacy-id");
    current =
      (requested && UUID_RE.test(requested) && pharmacies.find((p) => p.id === requested)) ||
      pharmacies.find((p) => p.id === user.pharmacyId) ||
      pharmacies.find((p) => p.is_active) ||
      null;
  }

  const count = async (table, build) => {
    const { count: n, error } = await build(supabase.from(table).select("id", { count: "exact", head: true }));
    if (error) unwrap({ error });
    return n ?? 0;
  };
  const [openAlerts, criticalAlerts, pendingReceipts] = await Promise.all([
    current ? count("pharmacy_alerts", (q) => q.eq("pharmacy_id", current.id).neq("status", "resolved")) : 0,
    current ? count("pharmacy_alerts", (q) => q.eq("pharmacy_id", current.id).eq("status", "open").eq("severity", "critical")) : 0,
    current ? count("shipments", (q) => q.eq("pharmacy_id", current.id).eq("status", "in_transit")) : 0,
  ]);

  res.json({
    counts: { openAlerts, criticalAlerts, pendingReceipts },
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      isAdmin: user.isAdmin,
      canUsePharmacy: user.isAdmin || (user.isPharmacyStaff && Boolean(user.pharmacyId)),
    },
    pharmacies: pharmacies.map(toPharmacy),
    currentPharmacy: toPharmacy(current),
  });
});

module.exports = router;
