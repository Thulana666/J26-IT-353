// /api/warehouse/staff - staff accounts and access (admins only).
//
// GET   /       accounts with role, status and assignment
// PATCH /:id    { role, status, pharmacyId?, warehouseId? } in one update:
//                 pharmacy_staff   needs a pharmacy (no warehouse)
//                 warehouse_staff  needs a warehouse (no pharmacy)
//                 admin            may have a warehouse (no pharmacy)
//                 user             neither
//
// Same profiles and audit log as Component 4's /api/pharmacy/admin/users,
// which stays available (it does not know about warehouses; the database
// clears a warehouse when the role no longer allows one).

const express = require("express");
const { supabase } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError } = require("../validation");
const { requireAdmin } = require("../auth");
const { audit } = require("../../pharmacy/routes/common");

const router = express.Router();
router.use(requireAdmin);

const ROLES = ["admin", "warehouse_staff", "pharmacy_staff", "user"];
const PROFILE_SELECT = "id, email, full_name, role, status, pharmacy_id, warehouse_id, created_at";

const toStaff = (row) => ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  role: row.role,
  status: row.status,
  pharmacyId: row.pharmacy_id,
  warehouseId: row.warehouse_id,
  createdAt: row.created_at,
});

// Which assignment a role takes; the other one is cleared.
function assignmentFor({ role, pharmacyId, warehouseId }) {
  if (role === "pharmacy_staff") {
    if (!pharmacyId) throw fieldError("pharmacyId", "Pharmacy staff need a pharmacy");
    return { pharmacy_id: pharmacyId, warehouse_id: null };
  }
  if (role === "warehouse_staff") {
    if (!warehouseId) throw fieldError("warehouseId", "Warehouse staff need a warehouse");
    return { pharmacy_id: null, warehouse_id: warehouseId };
  }
  if (role === "admin") return { pharmacy_id: null, warehouse_id: warehouseId ?? null };
  return { pharmacy_id: null, warehouse_id: null };
}

router.get("/", async (_req, res) => {
  const rows = unwrap(await supabase.from("profiles").select(PROFILE_SELECT).order("email"));
  res.json({ staff: rows.map(toStaff) });
});

router.patch("/:id", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const body = validate(req.body, {
    role: rules.oneOf(ROLES, { required: true }),
    status: rules.oneOf(["active", "inactive"], { required: true }),
    pharmacyId: rules.uuid({ nullable: true }),
    warehouseId: rules.uuid({ nullable: true }),
  });
  if (id === req.user.id && (body.role !== "admin" || body.status !== "active")) {
    throw new HttpError(409, "You cannot remove your own admin access");
  }
  const assignment = assignmentFor(body);

  if (assignment.pharmacy_id) {
    const pharmacy = unwrap(await supabase.from("pharmacies").select("id").eq("id", assignment.pharmacy_id).maybeSingle());
    if (!pharmacy) throw fieldError("pharmacyId", "Pharmacy not found");
  }
  if (assignment.warehouse_id) {
    const warehouse = unwrap(
      await supabase.from("warehouses").select("id, is_active").eq("id", assignment.warehouse_id).maybeSingle()
    );
    if (!warehouse) throw fieldError("warehouseId", "Warehouse not found");
    if (!warehouse.is_active) throw fieldError("warehouseId", "This warehouse is inactive");
  }

  const before = unwrap(await supabase.from("profiles").select(PROFILE_SELECT).eq("id", id).maybeSingle());
  if (!before) throw new HttpError(404, "User not found");
  const row = unwrap(
    await supabase
      .from("profiles")
      .update({ role: body.role, status: body.status, ...assignment })
      .eq("id", id)
      .select(PROFILE_SELECT)
      .single()
  );
  await audit(req, {
    action: "user.access_updated",
    entityType: "profile",
    entityId: id,
    pharmacyId: row.pharmacy_id ?? before.pharmacy_id ?? null,
    details: {
      before: { role: before.role, status: before.status, pharmacy_id: before.pharmacy_id, warehouse_id: before.warehouse_id },
      after: { role: row.role, status: row.status, pharmacy_id: row.pharmacy_id, warehouse_id: row.warehouse_id },
    },
  });
  res.json({ staff: toStaff(row) });
});

module.exports = router;
module.exports.assignmentFor = assignmentFor;
