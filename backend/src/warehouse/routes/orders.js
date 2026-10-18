// /api/warehouse/orders - fulfilment of pharmacy orders (Component 4's
// purchase_orders) by the warehouse.
//
// GET  /                              orders with their warehouse stage (?stage=&warehouseId=&limit=) and stage counts
// GET  /:id                           order, items with available stock, allocation and picks, shipment, receipt,
//                                     discrepancy reports, cold-chain handoff
// POST /:id/allocate                  reserve FEFO stock { items?: [{ orderItemId, quantity }], minShelfDays?, notes? }
// POST /:id/picks/:pickId/confirm     verify a pick at the shelf { batchCode, locationCode }
// POST /:id/cancel-allocation         release the reservation { reason }
// POST /:id/dispatch                  ship the picked order { notes?, coldChain?: { monitor, expectedDeliveryAt? } }
// POST /:id/decline                   decline a submitted order { reason } (Component 4's pharmacy_cancel_order)
//
// Stock changes only in the database functions (warehouse_allocate_order,
// warehouse_confirm_pick, warehouse_dispatch_fulfilment,
// warehouse_cancel_fulfilment), which lock rows and are idempotent.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError } = require("../validation");
const { todayISO, addDays } = require("../dates");
const { classifyExpiry, thresholdsOf } = require("../expiry");
const { ORDER_STAGES, orderStage, matchesLocation, identifyBatchInput } = require("../fulfilment");
const { toEvent, deliverPendingFor } = require("../integrations");
const { recordScan } = require("../scans");

const router = express.Router();
const { supabase } = store;

const ORDER_SELECT =
  "id, order_number, pharmacy_id, warehouse_id, status, notes, created_by, submitted_at, dispatched_at, received_at, " +
  "cancelled_at, cancel_reason, pharmacy:pharmacies(id, code, name), " +
  "items:purchase_order_items(id, quantity_ordered, notes, medicine:medicines(id, name, strength, unit, units_per_pack, storage_condition, is_controlled)), " +
  "shipment:shipments(id, shipment_number, status, dispatched_at, received_at)";

const PICK_SELECT =
  "id, order_item_id, medicine_id, batch_id, storage_location_id, quantity, pick_sequence, status, fefo_compliant, fefo_note, " +
  "picked_by, picked_at, picked_via, movement_id, batch:batches(batch_number, expiry_date, status), " +
  "location:storage_locations(code, rack:warehouse_racks(code, zone:warehouse_zones(code)))";

// PostgREST returns one-to-one embeds as an object or a one-element array.
const single = (value) => (Array.isArray(value) ? value[0] ?? null : value ?? null);

function toFulfilment(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    minShelfDays: row.min_shelf_days,
    notes: row.notes,
    allocatedAt: row.allocated_at,
    readyAt: row.ready_at,
    dispatchedAt: row.dispatched_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

function toPick(row, today, thresholds) {
  return {
    id: row.id,
    orderItemId: row.order_item_id,
    medicineId: row.medicine_id,
    batchId: row.batch_id,
    batchNumber: row.batch?.batch_number ?? null,
    expiryDate: row.batch?.expiry_date ?? null,
    batchStatus: row.batch?.status ?? null,
    expiry: row.batch ? classifyExpiry(row.batch.expiry_date, today, thresholds) : null,
    storageLocationId: row.storage_location_id,
    locationCode: row.location?.code ?? null,
    rackCode: row.location?.rack?.code ?? null,
    zoneCode: row.location?.rack?.zone?.code ?? null,
    quantity: row.quantity,
    sequence: row.pick_sequence,
    status: row.status,
    fefoCompliant: row.fefo_compliant,
    fefoNote: row.fefo_note,
    pickedAt: row.picked_at,
    pickedVia: row.picked_via,
  };
}

function toOrderSummary(row, fulfilment) {
  const shipment = single(row.shipment);
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    stage: orderStage(row, fulfilment, shipment),
    pharmacy: row.pharmacy ? { id: row.pharmacy.id, code: row.pharmacy.code, name: row.pharmacy.name } : null,
    warehouseId: row.warehouse_id,
    notes: row.notes,
    submittedAt: row.submitted_at,
    dispatchedAt: row.dispatched_at,
    receivedAt: row.received_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    itemCount: row.items?.length ?? 0,
    packsOrdered: (row.items ?? []).reduce((sum, item) => sum + item.quantity_ordered, 0),
    fulfilment: toFulfilment(fulfilment),
    shipment: shipment
      ? { id: shipment.id, shipmentNumber: shipment.shipment_number, status: shipment.status, dispatchedAt: shipment.dispatched_at, receivedAt: shipment.received_at }
      : null,
  };
}

async function liveFulfilments(orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = unwrap(
    await supabase.from("warehouse_order_fulfilments").select("*").in("order_id", orderIds).neq("status", "cancelled")
  );
  return new Map(rows.map((row) => [row.order_id, row]));
}

async function loadOrder(orderId) {
  const row = unwrap(await supabase.from("purchase_orders").select(ORDER_SELECT).eq("id", orderId).maybeSingle());
  if (!row) throw new HttpError(404, "Order not found");
  return row;
}

const idParams = { id: rules.uuid({ required: true }) };

router.get("/", async (req, res) => {
  const filters = validate(req.query, {
    stage: rules.oneOf(ORDER_STAGES),
    warehouseId: rules.uuid(),
    limit: rules.int({ min: 1, max: 500, default: 200 }),
  });
  let query = supabase.from("purchase_orders").select(ORDER_SELECT).order("submitted_at", { ascending: false }).limit(filters.limit);
  if (filters.warehouseId) query = query.eq("warehouse_id", filters.warehouseId);
  const rows = unwrap(await query);
  const fulfilments = await liveFulfilments(rows.map((row) => row.id));
  const orders = rows.map((row) => toOrderSummary(row, fulfilments.get(row.id)));
  const counts = Object.fromEntries(ORDER_STAGES.map((stage) => [stage, orders.filter((o) => o.stage === stage).length]));
  res.json({ counts, orders: filters.stage ? orders.filter((o) => o.stage === filters.stage) : orders });
});

router.get("/:id", async (req, res) => {
  const { id } = validate(req.params, idParams);
  const today = todayISO();
  const row = await loadOrder(id);
  const shipment = single(row.shipment);
  const [fulfilmentRows, warehouse] = await Promise.all([
    supabase.from("warehouse_order_fulfilments").select("*").eq("order_id", id).order("allocated_at", { ascending: false }).then(unwrap),
    row.warehouse_id ? store.getWarehouse(row.warehouse_id) : null,
  ]);
  const thresholds = thresholdsOf(warehouse);
  const live = fulfilmentRows.find((f) => f.status !== "cancelled") ?? null;
  const shown = live ?? fulfilmentRows.find((f) => f.status === "dispatched") ?? null;

  const [picks, stock, shipmentDetail, discrepancies, events] = await Promise.all([
    shown
      ? supabase.from("warehouse_order_picks").select(PICK_SELECT).eq("fulfilment_id", shown.id).order("pick_sequence").then(unwrap)
      : [],
    row.warehouse_id ? store.getStock({ warehouseId: row.warehouse_id }) : [],
    shipment
      ? supabase
          .from("shipments")
          .select(
            "id, shipment_number, status, dispatched_at, received_at, receipt_notes, " +
              "items:shipment_items(id, order_item_id, medicine_id, quantity_shipped, quantity_accepted, units_per_pack, verification_status, accepted_at, batch:batches(batch_number, expiry_date))"
          )
          .eq("id", shipment.id)
          .single()
          .then(unwrap)
      : null,
    shipment
      ? supabase
          .from("shipment_discrepancies")
          .select("id, report_number, discrepancy_type, expected_quantity, actual_quantity, notes, status, resolution_notes, reported_at, resolved_at, batch:batches(batch_number), medicine:medicines(name, strength)")
          .eq("shipment_id", shipment.id)
          .order("reported_at")
          .then(unwrap)
      : [],
    shipment
      ? supabase.from("warehouse_integration_events").select("*").eq("entity_id", shipment.id).then(unwrap)
      : [],
  ]);

  // Stock that allocation could use now (same rules as warehouse_allocate_order).
  const minShelfDays = live?.min_shelf_days ?? 30;
  const cutoff = addDays(today, minShelfDays);
  const items = row.items.map((item) => {
    const eligible = stock.filter(
      (s) =>
        s.medicineId === item.medicine.id &&
        s.zoneType === "storage" &&
        s.batchStatus === "active" &&
        s.expiryDate >= cutoff &&
        s.quantityAvailable > 0
    );
    const shortDated = stock.filter(
      (s) => s.medicineId === item.medicine.id && s.zoneType === "storage" && s.batchStatus === "active" &&
        s.expiryDate >= today && s.expiryDate < cutoff && s.quantityAvailable > 0
    );
    return {
      id: item.id,
      quantityOrdered: item.quantity_ordered,
      notes: item.notes,
      medicine: {
        id: item.medicine.id,
        name: item.medicine.name,
        strength: item.medicine.strength,
        unit: item.medicine.unit,
        unitsPerPack: item.medicine.units_per_pack,
        storageCondition: item.medicine.storage_condition,
        isControlled: item.medicine.is_controlled,
      },
      availablePacks: eligible.reduce((sum, s) => sum + s.quantityAvailable, 0),
      shortDatedPacks: shortDated.reduce((sum, s) => sum + s.quantityAvailable, 0),
      allocatedPacks: picks.filter((p) => p.order_item_id === item.id && p.status !== "released").reduce((sum, p) => sum + p.quantity, 0),
    };
  });

  res.json({
    today,
    order: toOrderSummary(row, live),
    items,
    fulfilment: toFulfilment(shown),
    picks: picks.map((p) => toPick(p, today, thresholds)),
    previousAllocations: fulfilmentRows.filter((f) => f.status === "cancelled").map(toFulfilment),
    shipment: shipmentDetail
      ? {
          id: shipmentDetail.id,
          shipmentNumber: shipmentDetail.shipment_number,
          status: shipmentDetail.status,
          dispatchedAt: shipmentDetail.dispatched_at,
          receivedAt: shipmentDetail.received_at,
          receiptNotes: shipmentDetail.receipt_notes,
          items: shipmentDetail.items.map((item) => ({
            id: item.id,
            orderItemId: item.order_item_id,
            medicineId: item.medicine_id,
            batchNumber: item.batch?.batch_number ?? null,
            expiryDate: item.batch?.expiry_date ?? null,
            quantityShipped: item.quantity_shipped,
            quantityAccepted: item.quantity_accepted,
            unitsPerPack: item.units_per_pack,
            verificationStatus: item.verification_status,
            acceptedAt: item.accepted_at,
          })),
        }
      : null,
    discrepancies: discrepancies.map((d) => ({
      id: d.id,
      reportNumber: d.report_number,
      type: d.discrepancy_type,
      expectedQuantity: d.expected_quantity,
      actualQuantity: d.actual_quantity,
      notes: d.notes,
      status: d.status,
      resolutionNotes: d.resolution_notes,
      reportedAt: d.reported_at,
      resolvedAt: d.resolved_at,
      batchNumber: d.batch?.batch_number ?? null,
      medicineName: d.medicine?.name ?? null,
      strength: d.medicine?.strength ?? null,
    })),
    integrations: events.map(toEvent),
  });
});

router.post("/:id/allocate", async (req, res) => {
  const { id } = validate(req.params, idParams);
  const body = validate(req.body, {
    minShelfDays: rules.int({ min: 0, max: 3650, default: 30 }),
    notes: rules.string({ max: 1000 }),
  });
  let items = null;
  if (req.body?.items !== undefined && req.body.items !== null) {
    if (!Array.isArray(req.body.items) || req.body.items.length > 200) throw fieldError("items", "must be a list");
    items = req.body.items.map((item) =>
      validate(item, {
        orderItemId: rules.uuid({ required: true }),
        quantity: rules.int({ required: true, min: 0, max: 1_000_000 }),
      })
    );
  }
  const fulfilment = await store.rpc("warehouse_allocate_order", {
    p_order_id: id,
    p_user_id: req.user.id,
    p_items: items,
    p_min_shelf_days: body.minShelfDays,
    p_notes: body.notes ?? null,
    p_today: todayISO(),
  });
  res.status(201).json({ fulfilment: toFulfilment(fulfilment) });
});

// Verifies one pick: the batch label (or typed batch number) and the location
// label (or typed code) must be the reserved ones. Every attempt is logged.
router.post("/:id/picks/:pickId/confirm", async (req, res) => {
  const { id, pickId } = validate(req.params, { ...idParams, pickId: rules.uuid({ required: true }) });
  const body = validate(req.body, {
    batchCode: rules.string({ required: true, max: 200 }),
    locationCode: rules.string({ required: true, max: 100 }),
  });
  const pick = unwrap(
    await supabase
      .from("warehouse_order_picks")
      .select(`${PICK_SELECT}, fulfilment:warehouse_order_fulfilments!inner(order_id)`)
      .eq("id", pickId)
      .maybeSingle()
  );
  if (!pick || pick.fulfilment.order_id !== id) throw new HttpError(404, "Pick not found for this order");

  const scan = {
    purpose: "pick",
    scannedCode: body.batchCode,
    locationCode: body.locationCode,
    pickId,
    userId: req.user.id,
  };
  const identified = identifyBatchInput(body.batchCode, pick.batch?.batch_number);
  let batchId = null;
  let via = "manual";
  if (identified.kind === "invalid") {
    await recordScan({ ...scan, result: identified.reason === "batch_mismatch" ? "batch_mismatch" : "invalid", message: identified.message });
    throw new HttpError(identified.reason === "batch_mismatch" ? 409 : 400, identified.message, { reason: identified.reason });
  }
  if (identified.kind === "qr") {
    const qr = unwrap(await supabase.from("batch_qr_codes").select("batch_id, is_active").eq("code", identified.code).maybeSingle());
    if (!qr || !qr.is_active) {
      const result = qr ? "inactive" : "not_found";
      const message = qr ? "This label has been deactivated; use the batch's current label" : "This QR code is not registered";
      await recordScan({ ...scan, result, batchId: qr?.batch_id ?? null, message });
      throw new HttpError(qr ? 410 : 404, message, { reason: result });
    }
    batchId = qr.batch_id;
    via = "qr_scan";
  } else {
    batchId = pick.batch_id;
  }

  if (batchId !== pick.batch_id) {
    const message = `Wrong batch: this pick is for batch ${pick.batch?.batch_number}`;
    await recordScan({ ...scan, result: "batch_mismatch", batchId, message });
    throw new HttpError(409, message, { reason: "batch_mismatch" });
  }
  if (!matchesLocation(body.locationCode, { id: pick.storage_location_id, code: pick.location?.code ?? "" })) {
    const message = `Wrong location: pick this batch from ${pick.location?.code}`;
    await recordScan({ ...scan, result: "location_mismatch", batchId, storageLocationId: pick.storage_location_id, message });
    throw new HttpError(409, message, { reason: "location_mismatch" });
  }

  const confirmed = await store.rpc("warehouse_confirm_pick", {
    p_pick_id: pickId,
    p_user_id: req.user.id,
    p_batch_id: batchId,
    p_location_id: pick.storage_location_id,
    p_via: via,
  });
  await recordScan({ ...scan, result: "ok", batchId, storageLocationId: pick.storage_location_id });
  res.json({ pick: { id: confirmed.id, status: confirmed.status, pickedVia: confirmed.picked_via, pickedAt: confirmed.picked_at } });
});

async function liveFulfilmentOf(orderId) {
  const row = unwrap(
    await supabase.from("warehouse_order_fulfilments").select("*").eq("order_id", orderId).neq("status", "cancelled").maybeSingle()
  );
  if (!row) throw new HttpError(409, "This order is not allocated");
  return row;
}

router.post("/:id/cancel-allocation", async (req, res) => {
  const { id } = validate(req.params, idParams);
  const { reason } = validate(req.body, { reason: rules.string({ required: true, min: 3, max: 1000 }) });
  const live = await liveFulfilmentOf(id);
  const fulfilment = await store.rpc("warehouse_cancel_fulfilment", {
    p_fulfilment_id: live.id,
    p_user_id: req.user.id,
    p_reason: reason,
  });
  res.json({ fulfilment: toFulfilment(fulfilment) });
});

router.post("/:id/dispatch", async (req, res) => {
  const { id } = validate(req.params, idParams);
  const body = validate(req.body, { notes: rules.string({ max: 1000 }) });
  // Sensor devices and limits are Component 2's job: monitor=true only hands
  // the shipment over; without it the shipment waits on Cold Chain -> Start monitoring.
  const coldChain = req.body?.coldChain
    ? validate(req.body.coldChain, { monitor: rules.bool({ default: false }), expectedDeliveryAt: rules.string({ max: 40 }) })
    : { monitor: false };
  if (coldChain.expectedDeliveryAt && Number.isNaN(Date.parse(coldChain.expectedDeliveryAt))) {
    throw fieldError("expectedDeliveryAt", "must be a date and time");
  }

  const live = unwrap(
    await supabase.from("warehouse_order_fulfilments").select("*").eq("order_id", id).neq("status", "cancelled").maybeSingle()
  );
  if (!live) throw new HttpError(409, "Allocate and pick this order before dispatching it");
  const shipment = await store.rpc("warehouse_dispatch_fulfilment", {
    p_fulfilment_id: live.id,
    p_user_id: req.user.id,
    p_notes: body.notes ?? null,
    p_cold_chain: {
      monitor: coldChain.monitor,
      expectedDeliveryAt: coldChain.expectedDeliveryAt ? new Date(coldChain.expectedDeliveryAt).toISOString() : null,
    },
    p_today: todayISO(),
  });

  // Hand the shipment to Component 2 now; a failure is recorded for retry and
  // does not undo the dispatch.
  const handoffs = await deliverPendingFor(shipment.id, { token: req.accessToken });
  res.status(201).json({
    shipment: { id: shipment.id, shipmentNumber: shipment.shipment_number, status: shipment.status },
    integrations: handoffs,
  });
});

router.post("/:id/decline", async (req, res) => {
  const { id } = validate(req.params, idParams);
  const { reason } = validate(req.body, { reason: rules.string({ required: true, min: 3, max: 1000 }) });
  const order = await store.rpc("pharmacy_cancel_order", { p_order_id: id, p_user_id: req.user.id, p_reason: reason });
  res.json({ order: { id: order.id, orderNumber: order.order_number, status: order.status } });
});

module.exports = router;
