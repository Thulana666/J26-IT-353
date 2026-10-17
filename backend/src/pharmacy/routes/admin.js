// /api/pharmacy/admin - administration (admins only).
//
// GET   /users                 all users with role, pharmacy and status
// PATCH /users/:id             role, pharmacy, status
// GET   /pharmacies            all pharmacies
// POST  /pharmacies            create a pharmacy
// GET   /products              catalogue with pharmacy fields and barcodes
// PATCH /products/:id          brand, manufacturer, dispensing unit, pack size, prices
// POST  /products/:id/barcodes add a barcode
// DELETE /barcodes/:id         remove a barcode

const express = require("express");
const { supabase, getMedicines, getMedicine } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requireAdmin, PHARMACY_SELECT } = require("../auth");
const { parse, z, id, int, num, text, requiredText, nullable, bool } = require("../validation");
const { toPharmacy, toProduct } = require("../mappers");
const { audit } = require("./common");

const router = express.Router();
router.use(requireAdmin);

const ROLES = ["admin", "user", "pharmacy_staff", "warehouse_staff"];

router.get("/users", async (_req, res) => {
  const rows = unwrap(
    await supabase.from("profiles").select("id, email, full_name, role, status, pharmacy_id, created_at").order("email")
  );
  res.json({
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      status: r.status,
      pharmacyId: r.pharmacy_id,
      createdAt: r.created_at,
    })),
  });
});

const userBody = z
  .object({
    role: z.enum(ROLES),
    status: z.enum(["active", "inactive"]),
    pharmacyId: nullable(id),
  })
  .refine((b) => b.role !== "pharmacy_staff" || b.pharmacyId, { message: "pharmacy staff need a pharmacy", path: ["pharmacyId"] });

router.patch("/users/:id", async (req, res) => {
  const { id: userId } = parse(z.object({ id }), req.params);
  const body = parse(userBody, req.body);
  if (userId === req.user.id && (body.role !== "admin" || body.status !== "active")) {
    throw new HttpError(409, "You cannot remove your own admin access");
  }
  const before = unwrap(await supabase.from("profiles").select("role, status, pharmacy_id").eq("id", userId).maybeSingle());
  if (!before) throw new HttpError(404, "User not found");
  const row = unwrap(
    await supabase
      .from("profiles")
      .update({ role: body.role, status: body.status, pharmacy_id: body.pharmacyId ?? null })
      .eq("id", userId)
      .select("id, email, role, status, pharmacy_id")
      .single()
  );
  await audit(req, {
    action: "user.access_updated",
    entityType: "profile",
    entityId: userId,
    pharmacyId: body.pharmacyId ?? before.pharmacy_id ?? null,
    details: { before, after: { role: row.role, status: row.status, pharmacy_id: row.pharmacy_id } },
  });
  res.json({ user: { id: row.id, email: row.email, role: row.role, status: row.status, pharmacyId: row.pharmacy_id } });
});

router.get("/pharmacies", async (_req, res) => {
  const rows = unwrap(await supabase.from("pharmacies").select(PHARMACY_SELECT).order("name"));
  res.json({ pharmacies: rows.map(toPharmacy) });
});

const pharmacyBody = z.object({
  code: z.string().trim().regex(/^[A-Z0-9-]{2,30}$/, "use 2-30 capital letters, digits or dashes"),
  name: requiredText(200),
  warehouseId: nullable(id),
  address: text(300),
  phone: text(40),
  licenseNumber: text(80),
});

router.post("/pharmacies", async (req, res) => {
  const body = parse(pharmacyBody, req.body);
  const row = unwrap(
    await supabase
      .from("pharmacies")
      .insert({
        code: body.code,
        name: body.name,
        warehouse_id: body.warehouseId ?? null,
        address: body.address ?? null,
        phone: body.phone ?? null,
        license_number: body.licenseNumber ?? null,
      })
      .select(PHARMACY_SELECT)
      .single()
  );
  await audit(req, { action: "pharmacy.created", entityType: "pharmacy", entityId: row.id, pharmacyId: row.id, details: body });
  res.status(201).json({ pharmacy: toPharmacy(row) });
});

router.get("/products", async (_req, res) => {
  const [medicines, barcodes] = await Promise.all([
    getMedicines({ activeOnly: false }),
    supabase.from("product_barcodes").select("id, medicine_id, barcode, symbology, packaging_level, is_primary").order("barcode").then(unwrap),
  ]);
  res.json({
    products: medicines.map((m) => ({
      ...toProduct(m),
      barcodes: barcodes
        .filter((b) => b.medicine_id === m.id)
        .map((b) => ({ id: b.id, barcode: b.barcode, symbology: b.symbology, packagingLevel: b.packaging_level, isPrimary: b.is_primary })),
    })),
  });
});

const productBody = z.object({
  brandName: text(120),
  manufacturer: text(120),
  dispensingUnit: text(80),
  unitsPerPack: int(1, 100_000),
  unitCost: nullable(num(0, 10_000_000)),
  retailPrice: nullable(num(0, 10_000_000)),
});

router.patch("/products/:id", async (req, res) => {
  const { id: medicineId } = parse(z.object({ id }), req.params);
  const body = parse(productBody, req.body);
  await getMedicine(medicineId);
  unwrap(
    await supabase
      .from("medicines")
      .update({
        brand_name: body.brandName ?? null,
        manufacturer: body.manufacturer ?? null,
        dispensing_unit: body.dispensingUnit ?? null,
        units_per_pack: body.unitsPerPack,
        unit_cost: body.unitCost ?? null,
        retail_price: body.retailPrice ?? null,
      })
      .eq("id", medicineId)
  );
  await audit(req, { action: "product.updated", entityType: "medicine", entityId: medicineId, details: body });
  res.json({ product: toProduct(await getMedicine(medicineId)) });
});

const barcodeBody = z.object({
  barcode: z.string().trim().regex(/^\S{3,128}$/, "3-128 characters without spaces"),
  symbology: z.enum(["EAN13", "EAN8", "UPCA", "CODE128", "GS1_DATAMATRIX", "QR", "INTERNAL"]),
  packagingLevel: z.enum(["unit", "pack"]),
  isPrimary: bool.optional(),
});

router.post("/products/:id/barcodes", async (req, res) => {
  const { id: medicineId } = parse(z.object({ id }), req.params);
  const body = parse(barcodeBody, req.body);
  await getMedicine(medicineId);
  const row = unwrap(
    await supabase
      .from("product_barcodes")
      .insert({ medicine_id: medicineId, barcode: body.barcode, symbology: body.symbology, packaging_level: body.packagingLevel, is_primary: body.isPrimary ?? false })
      .select("id")
      .single()
  );
  await audit(req, { action: "barcode.added", entityType: "product_barcode", entityId: row.id, details: { medicineId, ...body } });
  res.status(201).json({ id: row.id });
});

router.delete("/barcodes/:id", async (req, res) => {
  const { id: barcodeId } = parse(z.object({ id }), req.params);
  const row = unwrap(await supabase.from("product_barcodes").delete().eq("id", barcodeId).select("id, barcode, medicine_id").maybeSingle());
  if (!row) throw new HttpError(404, "Barcode not found");
  await audit(req, { action: "barcode.removed", entityType: "product_barcode", entityId: barcodeId, details: row });
  res.json({ ok: true });
});

module.exports = router;
