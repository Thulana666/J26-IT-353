// /api/pharmacy/shipments - warehouse -> pharmacy shipments.
//
// GET  /                          shipments the user may see (?status=&scope=all)
// GET  /:id                       one shipment: order, items (warehouse batch details), discrepancies
// POST /:id/receive               pharmacy: confirm receipt after physical inspection.
//                                 { acceptPartial?: true } accepts only undisputed items.
//                                 Quantities come from the shipment, never from the browser;
//                                 repeating the call changes nothing.
// POST /:id/items/:itemId/accept  pharmacy: accept a held (disputed) item after the warehouse
//                                 resolved its reports, with the verified number of packs

const express = require("express");
const { supabase, today, rpc, userNames } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requirePharmacyStaff, requireAnyStaff, pharmacyScope, assertCanSee } = require("../auth");
const { parse, z, id, int, text, bool } = require("../validation");
const { toShipment, toDiscrepancy } = require("../mappers");
const { refreshAlertsQuietly } = require("../analytics/service");
const { SHIPMENT_SELECT, DISCREPANCY_SELECT, scopeToVisible, parseList, attachHolds } = require("./common");

const router = express.Router();

const STATUSES = ["in_transit", "received", "received_with_discrepancies"];

async function loadShipment(req, shipmentId) {
  const row = unwrap(await supabase.from("shipments").select(SHIPMENT_SELECT).eq("id", shipmentId).maybeSingle());
  if (!row) throw new HttpError(404, "Shipment not found");
  assertCanSee(req, row.pharmacy_id, "Shipment");
  return row;
}

const namesOf = (rows) => userNames(rows.flatMap((r) => [r.dispatched_by, r.received_by, r.reported_by, r.resolved_by]));

const camel = (result) => ({
  alreadyProcessed: result.already_processed,
  shipmentId: result.shipment_id,
  shipmentNumber: result.shipment_number,
  status: result.status,
  itemsAccepted: result.items_accepted,
  itemsHeld: result.items_held,
  unitsAdded: result.units_added,
});

router.get("/", requireAnyStaff, async (req, res) => {
  const { statuses, limit } = parseList(req, STATUSES);
  let query = supabase.from("shipments").select(SHIPMENT_SELECT).order("dispatched_at", { ascending: false }).limit(limit);
  query = scopeToVisible(query, req);
  if (statuses.length) query = query.in("status", statuses);
  const rows = unwrap(await query);
  const names = await namesOf(rows);
  const discrepancies = rows.length
    ? unwrap(await supabase.from("shipment_discrepancies").select("shipment_id, status").in("shipment_id", rows.map((r) => r.id)))
    : [];
  res.json({
    shipments: rows.map((row) => ({
      ...toShipment(row, names),
      discrepancyCount: discrepancies.filter((d) => d.shipment_id === row.id).length,
      openDiscrepancyCount: discrepancies.filter((d) => d.shipment_id === row.id && d.status !== "resolved").length,
    })),
  });
});

router.get("/:id", requireAnyStaff, async (req, res) => {
  const { id: shipmentId } = parse(z.object({ id }), req.params);
  const row = await loadShipment(req, shipmentId);
  const [discrepancies, order] = await Promise.all([
    supabase.from("shipment_discrepancies").select(DISCREPANCY_SELECT).eq("shipment_id", shipmentId).order("reported_at").then(unwrap),
    supabase
      .from("purchase_orders")
      .select("id, order_number, status, notes, submitted_at, items:purchase_order_items(id, quantity_ordered, medicine:medicines(id, name, strength, unit, units_per_pack))")
      .eq("id", row.order_id)
      .single()
      .then(unwrap),
  ]);
  const names = await namesOf([row, ...discrepancies]);
  res.json({
    shipment: toShipment(row, names),
    order: {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      notes: order.notes,
      submittedAt: order.submitted_at,
      items: order.items.map((i) => ({
        id: i.id,
        quantityOrdered: i.quantity_ordered,
        medicineId: i.medicine?.id,
        name: i.medicine?.name,
        strength: i.medicine?.strength,
        packUnit: i.medicine?.unit,
        unitsPerPack: i.medicine?.units_per_pack,
      })),
    },
    discrepancies: (await attachHolds(discrepancies)).map((d) => toDiscrepancy(d, names)),
  });
});

const receiveBody = z.object({ acceptPartial: bool.optional(), notes: text(1000) });

router.post("/:id/receive", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const { id: shipmentId } = parse(z.object({ id }), req.params);
  const body = parse(receiveBody, req.body);
  const result = await rpc("pharmacy_confirm_receipt", {
    p_shipment_id: shipmentId,
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_accept_partial: body.acceptPartial ?? false,
    p_notes: body.notes ?? null,
    p_today: today(),
  });
  if (!result.already_processed) refreshAlertsQuietly(req.pharmacy);
  res.json({ result: camel(result) });
});

const acceptBody = z.object({ quantity: int(0, 100_000), notes: text(500) });

router.post("/:id/items/:itemId/accept", requirePharmacyStaff, pharmacyScope, async (req, res) => {
  const { id: shipmentId, itemId } = parse(z.object({ id, itemId: id }), req.params);
  const body = parse(acceptBody, req.body);
  const item = unwrap(await supabase.from("shipment_items").select("id").eq("id", itemId).eq("shipment_id", shipmentId).maybeSingle());
  if (!item) throw new HttpError(404, "Shipment item not found");
  const result = await rpc("pharmacy_settle_shipment_item", {
    p_item_id: itemId,
    p_pharmacy_id: req.pharmacy.id,
    p_user_id: req.user.id,
    p_quantity: body.quantity,
    p_notes: body.notes ?? null,
    p_today: today(),
  });
  if (!result.already_processed) refreshAlertsQuietly(req.pharmacy);
  res.json({
    result: {
      alreadyProcessed: result.already_processed,
      itemId: result.item_id,
      quantityAccepted: result.quantity_accepted,
      unitsAdded: result.units_added,
    },
  });
});

module.exports = router;
