// /api/pharmacy/settings - settings of the current pharmacy.
//
// GET    /                     pharmacy profile, defaults, reorder settings per product
// PATCH  /defaults             lead time, review period, service level, windows (staff, admin)
// PATCH  /profile              name, contact, warehouse, tax, discount limit (admin)
// PUT    /reorder/:medicineId  product reorder settings (staff, admin)
// DELETE /reorder/:medicineId  back to the pharmacy defaults

const express = require("express");
const { supabase, getMedicines, getReorderSettings } = require("../store");
const { unwrap } = require("../errors");
const { requirePharmacyStaff, requireAdmin, pharmacyScope, PHARMACY_SELECT } = require("../auth");
const { parse, z, id, int, num, text, requiredText, nullable, bool } = require("../validation");
const { toPharmacy, toProduct } = require("../mappers");
const { resolveSettings } = require("../analytics/service");
const { audit } = require("./common");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

const toReorderRow = (row) =>
  row && {
    leadTimeDays: row.lead_time_days,
    reviewPeriodDays: row.review_period_days,
    safetyStockMethod: row.safety_stock_method,
    serviceLevel: row.service_level === null ? null : Number(row.service_level),
    safetyStockDays: row.safety_stock_days === null ? null : Number(row.safety_stock_days),
    safetyStockUnits: row.safety_stock_units,
    lowStockThreshold: row.low_stock_threshold,
    minOrderPacks: row.min_order_packs,
    maxStockUnits: row.max_stock_units,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };

router.get("/", async (req, res) => {
  const [medicines, settings, warehouses, stocked] = await Promise.all([
    getMedicines(),
    getReorderSettings(req.pharmacy.id),
    supabase.from("warehouses").select("id, code, name").eq("is_active", true).order("code").then(unwrap),
    supabase.from("pharmacy_inventory").select("medicine_id").eq("pharmacy_id", req.pharmacy.id).then(unwrap),
  ]);
  const stockedIds = new Set(stocked.map((r) => r.medicine_id));
  res.json({
    pharmacy: toPharmacy(req.pharmacy),
    canEditProfile: req.user.isAdmin,
    warehouses,
    products: medicines
      .map((m) => ({
        product: toProduct(m),
        stocked: stockedIds.has(m.id),
        custom: toReorderRow(settings.get(m.id)) ?? null,
        effective: resolveSettings(req.pharmacy, settings.get(m.id)),
      }))
      .sort((a, b) => Number(b.stocked) - Number(a.stocked) || a.product.name.localeCompare(b.product.name)),
  });
});

const defaultsBody = z.object({
  defaultLeadTimeDays: int(0, 90),
  defaultReviewPeriodDays: int(1, 90),
  defaultServiceLevel: num(0.5, 0.999),
  burnRateWindowDays: int(7, 365),
  nearExpiryDays: int(1, 730),
});

async function updatePharmacy(req, values, action) {
  const row = unwrap(await supabase.from("pharmacies").update(values).eq("id", req.pharmacy.id).select(PHARMACY_SELECT).single());
  await audit(req, { action, entityType: "pharmacy", entityId: req.pharmacy.id, pharmacyId: req.pharmacy.id, details: values });
  return row;
}

router.patch("/defaults", async (req, res) => {
  const body = parse(defaultsBody, req.body);
  const row = await updatePharmacy(
    req,
    {
      default_lead_time_days: body.defaultLeadTimeDays,
      default_review_period_days: body.defaultReviewPeriodDays,
      default_service_level: body.defaultServiceLevel,
      burn_rate_window_days: body.burnRateWindowDays,
      near_expiry_days: body.nearExpiryDays,
    },
    "settings.defaults_updated"
  );
  res.json({ pharmacy: toPharmacy(row) });
});

const profileBody = z.object({
  name: requiredText(200),
  address: text(300),
  phone: text(40),
  licenseNumber: text(80),
  warehouseId: nullable(id),
  taxRatePercent: num(0, 100),
  maxDiscountPercent: num(0, 100),
  isActive: bool,
});

router.patch("/profile", requireAdmin, async (req, res) => {
  const body = parse(profileBody, req.body);
  const row = await updatePharmacy(
    req,
    {
      name: body.name,
      address: body.address ?? null,
      phone: body.phone ?? null,
      license_number: body.licenseNumber ?? null,
      warehouse_id: body.warehouseId ?? null,
      tax_rate_percent: body.taxRatePercent,
      max_discount_percent: body.maxDiscountPercent,
      is_active: body.isActive,
    },
    "settings.profile_updated"
  );
  res.json({ pharmacy: toPharmacy(row) });
});

const reorderBody = z
  .object({
    leadTimeDays: nullable(int(0, 90)),
    reviewPeriodDays: nullable(int(1, 90)),
    safetyStockMethod: z.enum(["service_level", "days_of_cover", "fixed_units"]),
    serviceLevel: nullable(num(0.5, 0.999)),
    safetyStockDays: nullable(num(0, 365)),
    safetyStockUnits: nullable(int(0, 1_000_000)),
    lowStockThreshold: nullable(int(0, 1_000_000)),
    minOrderPacks: int(1, 10_000),
    maxStockUnits: nullable(int(1, 10_000_000)),
    isActive: bool,
  })
  .refine((b) => b.safetyStockMethod !== "days_of_cover" || b.safetyStockDays !== null, {
    message: "required for the days-of-cover method",
    path: ["safetyStockDays"],
  })
  .refine((b) => b.safetyStockMethod !== "fixed_units" || b.safetyStockUnits !== null, {
    message: "required for the fixed-units method",
    path: ["safetyStockUnits"],
  });

router.put("/reorder/:medicineId", async (req, res) => {
  const { medicineId } = parse(z.object({ medicineId: id }), req.params);
  const b = parse(reorderBody, req.body);
  const values = {
    pharmacy_id: req.pharmacy.id,
    medicine_id: medicineId,
    lead_time_days: b.leadTimeDays ?? null,
    review_period_days: b.reviewPeriodDays ?? null,
    safety_stock_method: b.safetyStockMethod,
    service_level: b.serviceLevel ?? null,
    safety_stock_days: b.safetyStockDays ?? null,
    safety_stock_units: b.safetyStockUnits ?? null,
    low_stock_threshold: b.lowStockThreshold ?? null,
    min_order_packs: b.minOrderPacks,
    max_stock_units: b.maxStockUnits ?? null,
    is_active: b.isActive,
    updated_by: req.user.id,
  };
  const row = unwrap(await supabase.from("reorder_settings").upsert(values, { onConflict: "pharmacy_id,medicine_id" }).select("*").single());
  await audit(req, { action: "settings.reorder_updated", entityType: "reorder_settings", entityId: row.id, pharmacyId: req.pharmacy.id, details: b });
  res.json({ settings: toReorderRow(row) });
});

router.delete("/reorder/:medicineId", async (req, res) => {
  const { medicineId } = parse(z.object({ medicineId: id }), req.params);
  unwrap(await supabase.from("reorder_settings").delete().eq("pharmacy_id", req.pharmacy.id).eq("medicine_id", medicineId));
  await audit(req, { action: "settings.reorder_reset", entityType: "medicine", entityId: medicineId, pharmacyId: req.pharmacy.id });
  res.json({ ok: true });
});

module.exports = router;
