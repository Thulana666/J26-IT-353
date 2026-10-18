// /api/cold-chain/shipments - Component 4 shipments under cold-chain monitoring.
// The id is the shipment's own id (shipments.id).
//
// GET   /               monitored shipments the user may see (?status=active|ended&test=true|false&limit=),
//                       each with its newest reading, connection, delivery, open alerts and newest prediction
// GET   /available      admin/warehouse: shipments in transit that are not monitored yet, with default limits
// POST  /               admin/warehouse: start monitoring a shipment
// GET   /:id            one monitored shipment (same shape as the list)
// PATCH /:id            admin/warehouse: device, limits, expected delivery, reading interval;
//                       { monitoringStatus: "ended" } stops accepting new readings
// GET   /:id/readings   readings oldest first (?from=&to=&limit=, default the newest 1000)
// GET   /:id/alerts     alerts, most recent first (?status=open,acknowledged,resolved&limit=)
// GET   /:id/risk       the newest risk prediction, or null when there is none yet
//
// Trip workflow (admin/warehouse): ready_for_dispatch -> allocated -> in_transit -> delivered
// POST  /:id/allocate   { driverId, truckId, deviceId? } assign (or change, before the start) driver, truck
//                       and sensor device (default: the truck's installed device)
// POST  /:id/start      start the trip: readings are accepted from now; driver on trip, truck in use
// POST  /:id/deliver    always 403: only the assigned driver confirms delivery, in the Driver Portal
//                       (POST /api/cold-chain/driver/deliveries/:id/deliver). Repeating start changes nothing.
// GET   /:id/issues     problems the driver reported (staff)
// GET   /?tripStatus=delivered   shipment history (each item has a summary of readings, alerts, risk)

const express = require("express");
const { supabase, MONITOR_SELECT, READING_SELECT, ALERT_SELECT, ISSUE_SELECT, loadMonitor, loadShipmentState, audit } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requireAnyStaff, requireWarehouseStaff, assertCanSee } = require("../../pharmacy/auth");
const { scopeToVisible } = require("../../pharmacy/routes/common");
const { userNames } = require("../../pharmacy/store");
const {
  parse,
  z,
  id,
  listQuery,
  readingsQuery,
  alertsQuery,
  monitorCreate,
  monitorUpdate,
  allocateBody,
} = require("../validation");
const { evaluateRisk } = require("../risk/service");
const { defaultLimits, mergeLimits } = require("../monitoring");
const { toMonitor, toReading, toAlert, toPrediction, toLimits, toIssue } = require("../mappers");
const { ALERT_STATUSES } = require("../constants");

const router = express.Router();

// PostgREST returns at most 1000 rows per request.
const PAGE_SIZE = 1000;

const MIXED_WARNING = "Items in this shipment need different storage conditions; the limits use the strictest one.";

async function withState(rows) {
  const state = await loadShipmentState(rows.map((row) => row.shipment_id));
  const now = Date.now();
  return rows.map((row) =>
    toMonitor(row, {
      latest: state.latest.get(row.shipment_id),
      prediction: state.predictions.get(row.shipment_id),
      openAlerts: state.alerts.get(row.shipment_id),
      summary: state.summaries.get(row.shipment_id),
      now,
    })
  );
}

// The monitored shipment in req.params.id, if the user may see it.
async function loadVisible(req, select) {
  const { id: shipmentId } = parse(z.object({ id }), req.params);
  const row = await loadMonitor(shipmentId, select);
  assertCanSee(req, row.pharmacy_id, "Monitored shipment");
  return row;
}

const fieldErrors = (fields) => new HttpError(400, "Invalid request", { fields });

// A device may report for one active shipment at a time; simulators only for test shipments.
async function assertDeviceAssignable(deviceId, { isTest, shipmentId = null }) {
  const device = unwrap(
    await supabase.from("cold_chain_devices").select("id, device_code, device_type, is_active").eq("id", deviceId).maybeSingle()
  );
  if (!device) throw new HttpError(404, "Device not found");
  if (!device.is_active) throw new HttpError(409, `Device ${device.device_code} is deactivated`);
  if (device.device_type === "simulator" && !isTest) {
    throw new HttpError(409, "A simulator can only be assigned to a test shipment");
  }
  let query = supabase
    .from("cold_chain_shipments")
    .select("shipment_id, shipment:shipments(shipment_number)")
    .eq("device_id", deviceId)
    .eq("monitoring_status", "active");
  if (shipmentId) query = query.neq("shipment_id", shipmentId);
  const [busy] = unwrap(await query.limit(1));
  if (busy) {
    throw new HttpError(
      409,
      `Device ${device.device_code} is already reporting for shipment ${busy.shipment?.shipment_number ?? busy.shipment_id}`
    );
  }
}

router.get("/", requireAnyStaff, async (req, res) => {
  const query = parse(listQuery, req.query);
  let builder = supabase
    .from("cold_chain_shipments")
    .select(MONITOR_SELECT)
    .order("started_at", { ascending: false })
    .limit(query.limit ?? 100);
  builder = scopeToVisible(builder, req);
  if (query.status) builder = builder.eq("monitoring_status", query.status);
  if (query.tripStatus) builder = builder.in("trip_status", query.tripStatus.split(","));
  if (query.test !== undefined) builder = builder.eq("is_test", query.test);
  res.json({ shipments: await withState(unwrap(await builder)) });
});

router.get("/available", requireWarehouseStaff, async (_req, res) => {
  const shipments = unwrap(
    await supabase
      .from("shipments")
      .select(
        "id, shipment_number, dispatched_at, pharmacy:pharmacies(name), warehouse:warehouses(name), " +
          "items:shipment_items(quantity_shipped, medicine:medicines(name, strength, storage_condition), batch:batches(batch_number))"
      )
      .eq("status", "in_transit")
      .order("dispatched_at", { ascending: false })
      .limit(200)
  );
  const monitored = shipments.length
    ? unwrap(await supabase.from("cold_chain_shipments").select("shipment_id").in("shipment_id", shipments.map((s) => s.id)))
    : [];
  const monitoredIds = new Set(monitored.map((row) => row.shipment_id));

  res.json({
    shipments: shipments
      .filter((shipment) => !monitoredIds.has(shipment.id))
      .map((shipment) => {
        const { mixed, ...limits } = defaultLimits(shipment.items.map((item) => item.medicine?.storage_condition));
        return {
          shipmentId: shipment.id,
          shipmentNumber: shipment.shipment_number,
          dispatchedAt: shipment.dispatched_at,
          originName: shipment.warehouse?.name ?? null,
          destinationName: shipment.pharmacy?.name ?? null,
          items: shipment.items.map((item) => ({
            medicineName: item.medicine?.name ?? null,
            strength: item.medicine?.strength ?? null,
            storageCondition: item.medicine?.storage_condition ?? null,
            batchNumber: item.batch?.batch_number ?? null,
            quantityShipped: item.quantity_shipped,
          })),
          defaultLimits: limits,
          warnings: mixed ? [MIXED_WARNING] : [],
        };
      }),
  });
});

router.post("/", requireWarehouseStaff, async (req, res) => {
  const body = parse(monitorCreate, req.body);
  const shipment = unwrap(
    await supabase
      .from("shipments")
      .select("id, shipment_number, status, dispatched_at, pharmacy_id, items:shipment_items(medicine:medicines(storage_condition))")
      .eq("id", body.shipmentId)
      .maybeSingle()
  );
  if (!shipment) throw new HttpError(404, "Shipment not found");
  if (shipment.status !== "in_transit") throw new HttpError(409, "Only shipments in transit can be monitored");
  const existing = unwrap(
    await supabase.from("cold_chain_shipments").select("shipment_id").eq("shipment_id", shipment.id).maybeSingle()
  );
  if (existing) throw new HttpError(409, `Shipment ${shipment.shipment_number} is already monitored`);

  const defaults = defaultLimits(shipment.items.map((item) => item.medicine?.storage_condition));
  const { limits, errors } = mergeLimits(defaults, body);
  if (errors) throw fieldErrors(errors);
  const startedAt = body.startedAt ?? shipment.dispatched_at;
  if (body.expectedDeliveryAt && Date.parse(body.expectedDeliveryAt) <= Date.parse(startedAt)) {
    throw fieldErrors({ expectedDeliveryAt: "must be after monitoring starts" });
  }
  const isTest = body.isTest ?? false;
  if (body.deviceId) await assertDeviceAssignable(body.deviceId, { isTest });

  const row = unwrap(
    await supabase
      .from("cold_chain_shipments")
      .insert({
        shipment_id: shipment.id,
        pharmacy_id: shipment.pharmacy_id,
        device_id: body.deviceId ?? null,
        storage_condition: limits.storageCondition,
        temp_min_c: limits.tempMinC,
        temp_max_c: limits.tempMaxC,
        humidity_min_pct: limits.humidityMinPct,
        humidity_max_pct: limits.humidityMaxPct,
        expected_delivery_at: body.expectedDeliveryAt ?? null,
        reading_interval_seconds: body.readingIntervalSeconds ?? 60,
        is_test: isTest,
        started_at: startedAt,
        created_by: req.user.id,
      })
      .select(MONITOR_SELECT)
      .single()
  );
  await audit(req, {
    action: "cold_chain.monitoring_started",
    entityType: "shipment",
    entityId: shipment.id,
    pharmacyId: shipment.pharmacy_id,
    details: { ...body, limits },
  });
  const [monitored] = await withState([row]);
  res.status(201).json({ shipment: monitored, warnings: defaults.mixed ? [MIXED_WARNING] : [] });
});

router.get("/:id", requireAnyStaff, async (req, res) => {
  const [monitored] = await withState([await loadVisible(req)]);
  res.json({ shipment: monitored });
});

router.patch("/:id", requireWarehouseStaff, async (req, res) => {
  const current = await loadVisible(req);
  const body = parse(monitorUpdate, req.body);
  if (current.monitoring_status === "ended") throw new HttpError(409, "Monitoring of this shipment has ended");

  const { limits, errors } = mergeLimits(toLimits(current), body);
  if (errors) throw fieldErrors(errors);
  const changes = {
    temp_min_c: limits.tempMinC,
    temp_max_c: limits.tempMaxC,
    humidity_min_pct: limits.humidityMinPct,
    humidity_max_pct: limits.humidityMaxPct,
  };
  if (body.readingIntervalSeconds !== undefined) changes.reading_interval_seconds = body.readingIntervalSeconds;
  if (body.expectedDeliveryAt !== undefined) {
    if (body.expectedDeliveryAt && Date.parse(body.expectedDeliveryAt) <= Date.parse(current.started_at)) {
      throw fieldErrors({ expectedDeliveryAt: "must be after monitoring starts" });
    }
    changes.expected_delivery_at = body.expectedDeliveryAt;
  }
  if (body.deviceId !== undefined) {
    if (body.deviceId) await assertDeviceAssignable(body.deviceId, { isTest: current.is_test, shipmentId: current.shipment_id });
    changes.device_id = body.deviceId;
  }
  if (body.monitoringStatus === "ended") {
    if (["allocated", "in_transit"].includes(current.trip_status)) {
      throw new HttpError(409, "This trip is still live: mark it delivered instead of ending the monitoring");
    }
    changes.monitoring_status = "ended";
    changes.ended_at = new Date().toISOString();
  }

  const row = unwrap(
    await supabase
      .from("cold_chain_shipments")
      .update(changes)
      .eq("shipment_id", current.shipment_id)
      .select(MONITOR_SELECT)
      .single()
  );
  await audit(req, {
    action: body.monitoringStatus === "ended" ? "cold_chain.monitoring_ended" : "cold_chain.monitoring_updated",
    entityType: "shipment",
    entityId: current.shipment_id,
    pharmacyId: current.pharmacy_id,
    details: body,
  });
  const [monitored] = await withState([row]);
  res.json({ shipment: monitored });
});

router.get("/:id/readings", requireAnyStaff, async (req, res) => {
  const { shipment_id: shipmentId } = await loadVisible(req, "shipment_id, pharmacy_id");
  const query = parse(readingsQuery, req.query);
  const limit = query.limit ?? 1000;

  // Newest first in keyset pages, then reversed: the latest `limit` readings
  // of the range, oldest first.
  const rows = [];
  let before = null;
  while (rows.length < limit) {
    const size = Math.min(PAGE_SIZE, limit - rows.length);
    let builder = supabase
      .from("cold_chain_readings")
      .select(READING_SELECT)
      .eq("shipment_id", shipmentId)
      .order("recorded_at", { ascending: false })
      .limit(size);
    if (query.from) builder = builder.gte("recorded_at", query.from);
    if (before) builder = builder.lt("recorded_at", before);
    else if (query.to) builder = builder.lte("recorded_at", query.to);
    const page = unwrap(await builder);
    rows.push(...page);
    if (page.length < size) break;
    before = page[page.length - 1].recorded_at;
  }
  rows.reverse();
  // truncated: the range may hold older readings than the ones returned.
  res.json({ shipmentId, readings: rows.map(toReading), truncated: rows.length === limit });
});

router.get("/:id/alerts", requireAnyStaff, async (req, res) => {
  const { shipment_id: shipmentId } = await loadVisible(req, "shipment_id, pharmacy_id");
  const query = parse(alertsQuery, req.query);
  const statuses = query.status ? query.status.split(",").filter(Boolean) : [];
  if (statuses.some((status) => !ALERT_STATUSES.includes(status))) {
    throw fieldErrors({ status: `must be one or more of ${ALERT_STATUSES.join(", ")}` });
  }
  let builder = supabase
    .from("cold_chain_alerts")
    .select(ALERT_SELECT)
    .eq("shipment_id", shipmentId)
    .order("last_detected_at", { ascending: false })
    .limit(query.limit ?? 100);
  if (statuses.length) builder = builder.in("status", statuses);
  const rows = unwrap(await builder);
  const names = await userNames(rows.map((row) => row.acknowledged_by));
  res.json({ shipmentId, alerts: rows.map((row) => toAlert(row, names)) });
});

router.get("/:id/risk", requireAnyStaff, async (req, res) => {
  const { shipment_id: shipmentId } = await loadVisible(req, "shipment_id, pharmacy_id");
  const row = unwrap(
    await supabase
      .from("cold_chain_risk_predictions")
      .select("*")
      .eq("shipment_id", shipmentId)
      .order("predicted_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  res.json({ shipmentId, prediction: toPrediction(row) });
});

// --- Trip workflow --------------------------------------------------------------

async function respondWithShipment(res, shipmentId) {
  const [monitored] = await withState([await loadMonitor(shipmentId)]);
  res.json({ shipment: monitored });
}

router.post("/:id/allocate", requireWarehouseStaff, async (req, res) => {
  const { shipment_id: shipmentId, pharmacy_id: pharmacyId } = await loadVisible(req, "shipment_id, pharmacy_id");
  const body = parse(allocateBody, req.body);
  unwrap(
    await supabase.rpc("cold_chain_allocate_trip", {
      p_shipment_id: shipmentId,
      p_driver_id: body.driverId,
      p_truck_id: body.truckId,
      p_device_id: body.deviceId ?? null,
      p_user_id: req.user.id,
    })
  );
  await audit(req, { action: "cold_chain.trip_allocated", entityType: "shipment", entityId: shipmentId, pharmacyId, details: body });
  await respondWithShipment(res, shipmentId);
});

router.post("/:id/start", requireWarehouseStaff, async (req, res) => {
  const { shipment_id: shipmentId, pharmacy_id: pharmacyId } = await loadVisible(req, "shipment_id, pharmacy_id");
  unwrap(await supabase.rpc("cold_chain_start_trip", { p_shipment_id: shipmentId, p_user_id: req.user.id }));
  await audit(req, { action: "cold_chain.trip_started", entityType: "shipment", entityId: shipmentId, pharmacyId });
  // First risk evaluation of the trip; a failure must not undo the start.
  await evaluateRisk(shipmentId).catch((error) => console.error(`[cold-chain] risk evaluation failed for ${shipmentId}: ${error.message}`));
  await respondWithShipment(res, shipmentId);
});

// Delivery is confirmed only by the assigned driver (Driver Portal). Staff can
// see the result but never confirm it, whatever the client sends.
router.post("/:id/deliver", () => {
  throw new HttpError(403, "Only the assigned driver can confirm delivery, in the Driver Portal");
});

router.get("/:id/issues", requireAnyStaff, async (req, res) => {
  const { shipment_id: shipmentId } = await loadVisible(req, "shipment_id, pharmacy_id");
  const rows = unwrap(await supabase.from("cold_chain_issues").select(ISSUE_SELECT).eq("shipment_id", shipmentId).order("created_at", { ascending: false }));
  const names = await userNames(rows.map((row) => row.resolved_by));
  res.json({ shipmentId, issues: rows.map((row) => toIssue(row, names)) });
});

module.exports = router;
