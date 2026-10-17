// /api/pharmacy/inventory - stock of the current pharmacy.
//
// GET  /                       products with batch-level stock (?q=&stock=&expiry=)
// GET  /lookup?code=           barcode / batch number / warehouse QR / name -> product + batches (FEFO)
// GET  /products/:medicineId   product details, batches, stock movements, recent sales
// POST /adjust                 stock count correction (admin)

const express = require("express");
const { supabase, today, addDays, fetchAll, getInventory, getMedicine, getReorderSettings, getDailyDemand, userNames, MEDICINE_SELECT } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, requireAdmin, pharmacyScope } = require("../auth");
const { parse, z, id, int, text, requiredText } = require("../validation");
const { toStockRow, toProduct, toMovement, toRecommendation, toDiscrepancy } = require("../mappers");
const { DISCREPANCY_SELECT, attachHolds } = require("./common");
const { byFefo, suggestBatch } = require("../fefo");
const { resolveSettings, refreshAlertsQuietly } = require("../analytics/service");

const router = express.Router();
router.use(requirePharmacyStaff, pharmacyScope);

const WAREHOUSE_QR_PREFIX = "PTWH:1:";


// Groups stock rows by product with totals and a stock status.
function groupByProduct(rows, thresholds) {
  const products = new Map();
  for (const row of rows) {
    const entry = products.get(row.product.id) ?? { product: row.product, batches: [] };
    entry.batches.push(row);
    products.set(row.product.id, entry);
  }
  return [...products.values()].map(({ product, batches }) => {
    const usable = batches.filter((b) => b.batchStatus === "active" && b.expiryStatus !== "expired");
    const available = usable.reduce((t, b) => t + b.quantityAvailable, 0);
    const threshold = thresholds.get(product.id) ?? null;
    const withStock = batches.filter((b) => b.quantityOnHand - b.quantityReserved > 0);
    const nearest = usable.filter((b) => b.quantityAvailable > 0).sort(byFefo)[0] ?? null;
    return {
      product,
      totals: {
        onHand: batches.reduce((t, b) => t + b.quantityOnHand, 0),
        reserved: batches.reduce((t, b) => t + b.quantityReserved, 0),
        held: batches.reduce((t, b) => t + b.quantityHeld, 0),
        available,
        value: Number(batches.reduce((t, b) => t + b.quantityOnHand * (b.unitCost ?? 0), 0).toFixed(2)),
      },
      lowStockThreshold: threshold,
      stockStatus: available <= 0 ? "out" : threshold !== null && available <= threshold ? "low" : "ok",
      hasExpired: withStock.some((b) => b.expiryStatus === "expired"),
      hasNearExpiry: withStock.some((b) => b.expiryStatus === "near_expiry" || b.expiryStatus === "critical"),
      nearestExpiry: nearest?.expiryDate ?? null,
      sellingPrice: nearest?.unitPrice ?? null,
      batches: batches.sort(byFefo),
    };
  });
}

// Low-stock threshold per product: the setting, else the current reorder point.
async function lowStockThresholds(pharmacyId) {
  const [settings, recs] = await Promise.all([
    getReorderSettings(pharmacyId),
    supabase.from("reorder_recommendations").select("medicine_id, reorder_point").eq("pharmacy_id", pharmacyId).eq("status", "pending").then(unwrap),
  ]);
  const thresholds = new Map(recs.map((r) => [r.medicine_id, Math.round(Number(r.reorder_point))]));
  for (const [medicineId, s] of settings) if (s.low_stock_threshold !== null) thresholds.set(medicineId, s.low_stock_threshold);
  return thresholds;
}

const listQuery = z.object({
  q: text(100),
  stock: z.enum(["all", "ok", "low", "out"]).optional(),
  expiry: z.enum(["all", "near_expiry", "expired"]).optional(),
});

router.get("/", async (req, res) => {
  const { q, stock = "all", expiry = "all" } = parse(listQuery, req.query);
  const todayISO = today();
  const [rows, thresholds, barcodes] = await Promise.all([
    getInventory(req.pharmacy.id),
    lowStockThresholds(req.pharmacy.id),
    q ? supabase.from("product_barcodes").select("medicine_id").ilike("barcode", `%${q}%`).then(unwrap) : [],
  ]);
  let products = groupByProduct(rows.map((row) => toStockRow(row, todayISO, req.pharmacy.near_expiry_days)), thresholds);

  if (q) {
    const needle = q.toLowerCase();
    const barcodeHits = new Set(barcodes.map((b) => b.medicine_id));
    products = products.filter(
      (p) =>
        barcodeHits.has(p.product.id) ||
        [p.product.name, p.product.genericName, p.product.brandName, p.product.manufacturer]
          .some((value) => value?.toLowerCase().includes(needle)) ||
        p.batches.some((b) => b.batchNumber.toLowerCase().includes(needle))
    );
  }
  if (stock !== "all") products = products.filter((p) => p.stockStatus === stock);
  if (expiry === "near_expiry") products = products.filter((p) => p.hasNearExpiry);
  if (expiry === "expired") products = products.filter((p) => p.hasExpired);

  res.json({
    today: todayISO,
    nearExpiryDays: req.pharmacy.near_expiry_days,
    products,
    totals: {
      products: products.length,
      units: products.reduce((t, p) => t + p.totals.onHand, 0),
      value: Number(products.reduce((t, p) => t + p.totals.value, 0).toFixed(2)),
    },
  });
});

const lookupQuery = z
  .object({ code: text(200), medicineId: id.optional() })
  .refine((q) => q.code || q.medicineId, { message: "is required", path: ["code"] });

// Resolves what was scanned or typed. Order: warehouse QR label, product
// barcode, batch number, then a name search (several matches possible).
// ?medicineId= picks a product directly (e.g. from the search matches).
router.get("/lookup", async (req, res) => {
  const { code = "", medicineId: chosen } = parse(lookupQuery, req.query);
  const todayISO = today();
  let match = chosen ? "product" : null;
  let medicineId = chosen ?? null;
  let batchId = null;

  if (!match && code.toUpperCase().startsWith(WAREHOUSE_QR_PREFIX)) {
    const qr = unwrap(await supabase.from("batch_qr_codes").select("batch_id, is_active, batch:batches(medicine_id)").eq("payload", code.toUpperCase()).maybeSingle());
    if (qr) {
      match = "warehouse_qr";
      batchId = qr.batch_id;
      medicineId = qr.batch?.medicine_id ?? null;
    }
  }
  if (!match) {
    const barcode = unwrap(await supabase.from("product_barcodes").select("medicine_id, packaging_level").eq("barcode", code).maybeSingle());
    if (barcode) {
      match = barcode.packaging_level === "pack" ? "pack_barcode" : "barcode";
      medicineId = barcode.medicine_id;
    }
  }
  if (!match) {
    // Case-insensitive exact match (LIKE wildcards escaped).
    const pattern = code.replace(/[\\%_]/g, (char) => `\\${char}`);
    const batch = unwrap(await supabase.from("batches").select("id, medicine_id").ilike("batch_number", pattern).limit(1).maybeSingle());
    if (batch) {
      match = "batch_number";
      batchId = batch.id;
      medicineId = batch.medicine_id;
    }
  }
  if (!match) {
    const escaped = code.replace(/[%_,()]/g, " ");
    const found = unwrap(
      await supabase
        .from("medicines")
        .select(MEDICINE_SELECT)
        .eq("is_active", true)
        .or(`name.ilike.%${escaped}%,generic_name.ilike.%${escaped}%,brand_name.ilike.%${escaped}%`)
        .order("name")
        .limit(10)
    );
    if (found.length === 0) return res.json({ match: null, code, product: null, batches: [], matches: [] });
    if (found.length > 1) return res.json({ match: "search", code, product: null, batches: [], matches: found.map(toProduct) });
    match = "search";
    medicineId = found[0].id;
  }

  const [product, rows] = await Promise.all([
    getMedicine(medicineId),
    fetchAll(() =>
      supabase.from("pharmacy_inventory_overview").select("*").eq("pharmacy_id", req.pharmacy.id).eq("medicine_id", medicineId).order("expiry_date").order("inventory_id")
    ),
  ]);
  const batches = rows.map((row) => toStockRow(row, todayISO, req.pharmacy.near_expiry_days)).sort(byFefo);
  const suggested = suggestBatch(batches, batchId);
  res.json({
    match,
    code,
    product: toProduct(product),
    scannedBatchId: batchId,
    suggestedBatchId: suggested?.batchId ?? null,
    batches,
    matches: [],
  });
});

router.get("/products/:medicineId", async (req, res) => {
  const { medicineId } = parse(z.object({ medicineId: id }), req.params);
  const todayISO = today();
  const [product, rows, barcodes, settings, recommendation, demand] = await Promise.all([
    getMedicine(medicineId),
    fetchAll(() =>
      supabase.from("pharmacy_inventory_overview").select("*").eq("pharmacy_id", req.pharmacy.id).eq("medicine_id", medicineId).order("expiry_date").order("inventory_id")
    ),
    supabase.from("product_barcodes").select("id, barcode, symbology, packaging_level, is_primary").eq("medicine_id", medicineId).order("packaging_level").then(unwrap),
    getReorderSettings(req.pharmacy.id),
    supabase
      .from("reorder_recommendations")
      .select("*")
      .eq("pharmacy_id", req.pharmacy.id)
      .eq("medicine_id", medicineId)
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(unwrap),
    getDailyDemand(req.pharmacy.id, addDays(todayISO, -30), addDays(todayISO, -1)),
  ]);
  const movements = unwrap(
    await supabase
      .from("stock_movements")
      .select("id, movement_type, on_hand_change, reserved_change, on_hand_after, reserved_after, reference_type, reference_id, notes, performed_by, created_at, batch:batches(batch_number)")
      .eq("pharmacy_id", req.pharmacy.id)
      .eq("medicine_id", medicineId)
      .order("created_at", { ascending: false })
      .order("entry_no", { ascending: false })
      .limit(100)
  );
  const discrepancies = unwrap(
    await supabase
      .from("shipment_discrepancies")
      .select(DISCREPANCY_SELECT)
      .eq("pharmacy_id", req.pharmacy.id)
      .eq("medicine_id", medicineId)
      .order("reported_at", { ascending: false })
      .limit(50)
  );
  const names = await userNames([...movements.map((m) => m.performed_by), ...discrepancies.flatMap((d) => [d.reported_by, d.resolved_by])]);
  const batches = rows.map((row) => toStockRow(row, todayISO, req.pharmacy.near_expiry_days)).sort(byFefo);

  res.json({
    today: todayISO,
    product: toProduct(product),
    barcodes: barcodes.map((b) => ({ id: b.id, barcode: b.barcode, symbology: b.symbology, packagingLevel: b.packaging_level, isPrimary: b.is_primary })),
    batches,
    totals: {
      onHand: batches.reduce((t, b) => t + b.quantityOnHand, 0),
      reserved: batches.reduce((t, b) => t + b.quantityReserved, 0),
      held: batches.reduce((t, b) => t + b.quantityHeld, 0),
      available: batches.filter((b) => b.batchStatus === "active" && b.expiryStatus !== "expired").reduce((t, b) => t + b.quantityAvailable, 0),
    },
    settings: resolveSettings(req.pharmacy, settings.get(medicineId)),
    hasCustomSettings: settings.has(medicineId),
    recommendation: recommendation ? toRecommendation(recommendation) : null,
    movements: movements.map((m) => toMovement(m, names)),
    discrepancies: (await attachHolds(discrepancies)).map((d) => toDiscrepancy(d, names)),
    dailySales: demand.filter((d) => d.medicine_id === medicineId).map((d) => ({ date: d.day, sold: d.quantity_sold, closingOnHand: d.closing_on_hand })),
  });
});

const adjustBody = z.object({
  batchId: id,
  change: int(-100_000, 100_000).refine((value) => value !== 0, "must not be zero"),
  reason: requiredText(300),
});

router.post("/adjust", requireAdmin, async (req, res) => {
  const body = parse(adjustBody, req.body);
  const row = unwrap(
    await supabase.rpc("pharmacy_adjust_stock", {
      p_pharmacy_id: req.pharmacy.id,
      p_batch_id: body.batchId,
      p_change: body.change,
      p_user_id: req.user.id,
      p_reason: body.reason,
    })
  );
  if (!row?.id) throw new HttpError(500, "The adjustment was not recorded");
  refreshAlertsQuietly(req.pharmacy);
  res.json({ inventoryId: row.id, quantityOnHand: row.quantity_on_hand, quantityReserved: row.quantity_reserved });
});

module.exports = router;
