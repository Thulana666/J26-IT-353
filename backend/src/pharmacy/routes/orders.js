// /api/pharmacy/orders - pharmacy orders to the warehouse.
//
// GET  /                      orders the user may see (?status=&scope=all&pharmacyId=)
// GET  /warehouse-stock       pharmacy: packs it can order from its supplying warehouse
// GET  /:id                   one order
// POST /                      pharmacy: submit an order (items may carry a recommendationId);
//                             refused when the warehouse does not have the quantity
// POST /:id/cancel            pharmacy: cancel its own order while it is still submitted
//
// The warehouse application reads these orders from the shared tables and
// dispatches them (shipments + shipment_items; see pharmacy_dispatch_order()).

const express = require("express");
const { supabase, rpc, userNames } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, requireAnyStaff, pharmacyScope, assertCanSee } = require("../auth");
const { parse, z, id, int, text, requiredText } = require("../validation");
const { toOrder } = require("../mappers");
const { MIN_SHELF_DAYS, getWarehouseAvailability, warehouseShortages } = require("../warehouse-stock");
const { ORDER_SELECT, scopeToVisible, parseList, single } = require("./common");

const router = express.Router();

const STATUSES = ["submitted", "dispatched", "received", "cancelled"];

async function loadOrder(req, orderId) {
  const row = unwrap(await supabase.from("purchase_orders").select(ORDER_SELECT).eq("id", orderId).maybeSingle());
  if (!row) throw new HttpError(404, "Order not found");
  assertCanSee(req, row.pharmacy_id, "Order");
  row.shipment = single(row.shipment);
  return row;
}

router.get("/", requireAnyStaff, async (req, res) => {
  const { statuses, limit } = parseList(req, STATUSES);
  let query = supabase.from("purchase_orders").select(ORDER_SELECT).order("submitted_at", { ascending: false }).limit(limit);
  query = scopeToVisible(query, req);
  if (statuses.length) query = query.in("status", statuses);
  const rows = unwrap(await query);
  const names = await userNames(rows.map((r) => r.created_by));
  res.json({ orders: rows.map((row) => toOrder({ ...row, shipment: single(row.shipment) }, names)) });
});

router.get("/warehouse-stock", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const warehouseId = req.pharmacy.warehouse_id;
  const [warehouse, packs] = await Promise.all([
    warehouseId ? supabase.from("warehouses").select("id, name").eq("id", warehouseId).maybeSingle().then(unwrap) : null,
    getWarehouseAvailability(warehouseId),
  ]);
  res.json({ warehouse, minShelfDays: MIN_SHELF_DAYS, stock: Object.fromEntries(packs), checkedAt: new Date().toISOString() });
});

router.get("/:id", requireAnyStaff, async (req, res) => {
  const { id: orderId } = parse(z.object({ id }), req.params);
  const row = await loadOrder(req, orderId);
  const names = await userNames([row.created_by]);
  res.json({ order: toOrder(row, names) });
});

const createBody = z.object({
  items: z
    .array(
      z.object({
        medicineId: id,
        quantity: int(1, 10_000),
        recommendationId: id.optional().nullable(),
        notes: text(300),
      })
    )
    .min(1, "add at least one product")
    .max(100),
  notes: text(1000),
});

router.post("/", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const body = parse(createBody, req.body);
  // Checked against the warehouse's stock now, not the quantities the page
  // showed. Without a supplying warehouse the function refuses the order.
  if (req.pharmacy.warehouse_id) {
    const medicineIds = [...new Set(body.items.map((i) => i.medicineId))];
    const [packs, medicines] = await Promise.all([
      getWarehouseAvailability(req.pharmacy.warehouse_id, medicineIds),
      supabase.from("medicines").select("id, name, strength, unit").in("id", medicineIds).then(unwrap),
    ]);
    const names = new Map(medicines.map((m) => [m.id, [m.name, m.strength].filter(Boolean).join(" ")]));
    const shortages = warehouseShortages(body.items, packs, names);
    if (shortages.length > 0) {
      const unit = new Map(medicines.map((m) => [m.id, m.unit ?? "pack"]));
      const lines = shortages.map((s) => `${s.name}: ${s.ordered} ${unit.get(s.medicineId)}(s) ordered, ${s.available === 0 ? "out of stock" : `${s.available} available`}`);
      throw new HttpError(409, `Not enough stock at the warehouse. ${lines.join("; ")}.`, { shortages });
    }
  }
  const order = await rpc("pharmacy_create_order", {
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_items: body.items,
    p_notes: body.notes ?? null,
  });
  res.status(201).json({ order: toOrder(await loadOrder(req, order.id)) });
});

router.post("/:id/cancel", requirePharmacyStaff, async (req, res) => {
  const { id: orderId } = parse(z.object({ id }), req.params);
  const { reason } = parse(z.object({ reason: requiredText(500) }), req.body);
  const order = await loadOrder(req, orderId);
  // Only the order's own pharmacy (checked by loadOrder and again by the function).
  await rpc("pharmacy_cancel_order", { p_order_id: orderId, p_user_id: req.user.id, p_reason: reason, p_pharmacy_id: order.pharmacy_id });
  res.json({ order: toOrder(await loadOrder(req, orderId)) });
});

module.exports = router;
