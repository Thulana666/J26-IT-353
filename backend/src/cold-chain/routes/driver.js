// /api/cold-chain/driver - the Driver Portal (role 'driver' only).
//
// The signed-in account must be an active driver account linked to a driver
// record (cold_chain_drivers.profile_id). Every query is filtered by that
// driver on the server: another driver's shipment answers 404, as if it did
// not exist.
//
// GET  /deliveries                  the driver's live (allocated, in transit) and recent delivered trips
// GET  /deliveries/:id              one of them: route, items, truck, latest sensor values, risk, alerts, issues
// POST /deliveries/:id/deliver      { notes? } confirm delivery (trip in transit). Only here: warehouse
//                                   staff and admins cannot confirm deliveries; the database checks it too.
// POST /deliveries/:id/issues       { issueType, description } report a problem (snapshot of the sensor)

const express = require("express");
const { supabase, ISSUE_SELECT, loadShipmentState, closePredictedAlerts, audit } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { parse, z, id, deliverBody, issueBody } = require("../validation");
const { num, toIssue, toPrediction, toReading } = require("../mappers");
const { connectionStatus, deliveryStatus } = require("../monitoring");

const router = express.Router();

const LIVE = ["allocated", "in_transit"];
const RECENT_DELIVERED = 5;

async function requireDriver(req, _res, next) {
  if (!req.user?.isActive || req.user.role !== "driver") throw new HttpError(403, "Only drivers can use the Driver Portal");
  const driver = unwrap(
    await supabase.from("cold_chain_drivers").select("id, full_name, phone, status").eq("profile_id", req.user.id).maybeSingle()
  );
  if (!driver) throw new HttpError(403, "Your account is not linked to a driver yet. Ask the warehouse to link it.");
  req.driver = driver;
  next();
}
router.use(requireDriver);

const LOCATION = "location:locations(name, latitude, longitude)";
const DELIVERY_SELECT =
  "shipment_id, trip_status, expected_delivery_at, allocated_at, trip_started_at, delivered_at, delivery_notes, " +
  "final_reading_at, final_temperature_c, final_humidity_pct, final_latitude, final_longitude, temp_min_c, temp_max_c, " +
  "humidity_min_pct, humidity_max_pct, reading_interval_seconds, monitoring_status, is_test, " +
  "truck:cold_chain_trucks(registration_number, truck_type, is_refrigerated, min_temp_c, max_temp_c), " +
  `pharmacy:pharmacies(name, address, phone, ${LOCATION}), ` +
  "shipment:shipments(shipment_number, status, dispatched_at, received_at, purchase_order:purchase_orders(order_number), " +
  `warehouse:warehouses(name, address, ${LOCATION}), ` +
  "items:shipment_items(quantity_shipped, medicine:medicines(name, strength, dosage_form), batch:batches(batch_number)))";

// The driver-facing view of a trip: what a driver needs, nothing more.
function toDelivery(row, { latest, prediction, alertSummary } = {}, now = Date.now()) {
  const shipment = row.shipment ?? {};
  const place = (p) => (p ? { name: p.name, address: p.address ?? null, phone: p.phone ?? null, latitude: num(p.location?.latitude), longitude: num(p.location?.longitude) } : null);
  const predicted = toPrediction(prediction);
  return {
    shipmentId: row.shipment_id,
    shipmentNumber: shipment.shipment_number ?? null,
    orderNumber: shipment.purchase_order?.order_number ?? null,
    status: row.trip_status,
    isTest: row.is_test,
    pharmacy: place(row.pharmacy),
    warehouse: place(shipment.warehouse),
    truck: row.truck
      ? {
          registrationNumber: row.truck.registration_number,
          truckType: row.truck.truck_type,
          isRefrigerated: row.truck.is_refrigerated,
          minTempC: num(row.truck.min_temp_c),
          maxTempC: num(row.truck.max_temp_c),
        }
      : null,
    items: (shipment.items ?? []).map((item) => ({
      medicineName: item.medicine?.name ?? null,
      strength: item.medicine?.strength ?? null,
      dosageForm: item.medicine?.dosage_form ?? null,
      batchNumber: item.batch?.batch_number ?? null,
      quantityShipped: item.quantity_shipped,
    })),
    limits: { tempMinC: num(row.temp_min_c), tempMaxC: num(row.temp_max_c), humidityMinPct: num(row.humidity_min_pct), humidityMaxPct: num(row.humidity_max_pct) },
    expectedDeliveryAt: row.expected_delivery_at,
    predictedArrival: predicted?.factors?.delivery_delay?.details?.estimatedArrival ?? null,
    startedAt: row.trip_started_at,
    deliveredAt: row.delivered_at,
    final: row.delivered_at
      ? { temperatureC: num(row.final_temperature_c), humidityPct: num(row.final_humidity_pct), latitude: num(row.final_latitude), longitude: num(row.final_longitude) }
      : null,
    delivery: deliveryStatus({ shipmentStatus: shipment.status, dispatchedAt: shipment.dispatched_at, expectedDeliveryAt: row.expected_delivery_at, receivedAt: shipment.received_at, now }),
    connection: connectionStatus({ lastReadingAt: latest?.recorded_at ?? null, intervalSeconds: row.reading_interval_seconds, monitoringStatus: row.monitoring_status, now }),
    latestReading: latest ? toReading(latest) : null,
    risk: predicted ? { riskLevel: predicted.riskLevel, riskProbability: predicted.riskProbability, riskType: predicted.riskType, explanation: predicted.explanation, isPrototype: predicted.isPrototype } : null,
    openAlerts: alertSummary ?? { count: 0, highestLevel: null },
  };
}

// One trip of this driver, or 404 (also for another driver's trip).
async function loadOwnTrip(req, select = DELIVERY_SELECT) {
  const { id: shipmentId } = parse(z.object({ id }), req.params);
  const row = unwrap(
    await supabase.from("cold_chain_shipments").select(select).eq("shipment_id", shipmentId).eq("driver_id", req.driver.id).maybeSingle()
  );
  if (!row) throw new HttpError(404, "Delivery not found");
  return row;
}

router.get("/deliveries", async (req, res) => {
  const rows = unwrap(
    await supabase
      .from("cold_chain_shipments")
      .select(DELIVERY_SELECT)
      .eq("driver_id", req.driver.id)
      .in("trip_status", [...LIVE, "delivered"])
      .order("delivered_at", { ascending: false, nullsFirst: true })
      .order("allocated_at", { ascending: true })
      .limit(50)
  );
  const live = rows.filter((r) => LIVE.includes(r.trip_status));
  const delivered = rows.filter((r) => r.trip_status === "delivered").slice(0, RECENT_DELIVERED);
  const state = await loadShipmentState([...live, ...delivered].map((r) => r.shipment_id));
  const now = Date.now();
  const view = (r) =>
    toDelivery(r, { latest: state.latest.get(r.shipment_id), prediction: state.predictions.get(r.shipment_id), alertSummary: state.alerts.get(r.shipment_id) }, now);
  res.json({
    driver: { id: req.driver.id, fullName: req.driver.full_name, status: req.driver.status },
    active: live.filter((r) => r.trip_status === "in_transit").map(view),
    upcoming: live.filter((r) => r.trip_status === "allocated").map(view),
    recent: delivered.map(view),
  });
});

router.get("/deliveries/:id", async (req, res) => {
  const row = await loadOwnTrip(req);
  const [state, alerts, issues] = await Promise.all([
    loadShipmentState([row.shipment_id]),
    supabase
      .from("cold_chain_alerts")
      .select("id, risk_type, risk_level, basis, risk_probability, title, message, last_detected_at")
      .eq("shipment_id", row.shipment_id)
      .neq("status", "resolved")
      .order("last_detected_at", { ascending: false })
      .limit(5)
      .then(unwrap),
    supabase.from("cold_chain_issues").select(ISSUE_SELECT).eq("shipment_id", row.shipment_id).order("created_at", { ascending: false }).then(unwrap),
  ]);
  res.json({
    driver: { id: req.driver.id, fullName: req.driver.full_name },
    delivery: toDelivery(row, {
      latest: state.latest.get(row.shipment_id),
      prediction: state.predictions.get(row.shipment_id),
      alertSummary: state.alerts.get(row.shipment_id),
    }),
    alerts: alerts.map((a) => ({
      id: a.id,
      riskType: a.risk_type,
      riskLevel: a.risk_level,
      basis: a.basis,
      riskProbability: num(a.risk_probability),
      title: a.title,
      message: a.message,
      lastDetectedAt: a.last_detected_at,
    })),
    issues: issues.map((i) => toIssue(i)),
  });
});

router.post("/deliveries/:id/deliver", async (req, res) => {
  const row = await loadOwnTrip(req, "shipment_id, trip_status, pharmacy_id");
  const body = parse(deliverBody, req.body);
  if (row.trip_status !== "in_transit" && row.trip_status !== "delivered") {
    throw new HttpError(409, "Only a delivery in transit can be confirmed");
  }
  // The database checks again that this account is the trip's driver.
  const trip = unwrap(
    await supabase.rpc("cold_chain_deliver_trip", { p_shipment_id: row.shipment_id, p_user_id: req.user.id, p_notes: body.notes ?? null })
  );
  await closePredictedAlerts(row.shipment_id);
  await audit(req, { action: "cold_chain.trip_delivered", entityType: "shipment", entityId: row.shipment_id, pharmacyId: row.pharmacy_id, details: { driverId: req.driver.id, ...body } });
  res.json({
    result: {
      shipmentId: row.shipment_id,
      status: trip.trip_status,
      deliveredAt: trip.delivered_at,
      final: {
        readingAt: trip.final_reading_at,
        temperatureC: num(trip.final_temperature_c),
        humidityPct: num(trip.final_humidity_pct),
        latitude: num(trip.final_latitude),
        longitude: num(trip.final_longitude),
      },
    },
  });
});

router.post("/deliveries/:id/issues", async (req, res) => {
  const row = await loadOwnTrip(req, "shipment_id, trip_status, pharmacy_id");
  const body = parse(issueBody, req.body);
  // The truck sensor's newest values travel with the report.
  const latest = unwrap(
    await supabase
      .from("cold_chain_latest_readings")
      .select("recorded_at, latitude, longitude, temperature_c, humidity_pct")
      .eq("shipment_id", row.shipment_id)
      .maybeSingle()
  );
  const issue = unwrap(
    await supabase
      .from("cold_chain_issues")
      .insert({
        shipment_id: row.shipment_id,
        pharmacy_id: row.pharmacy_id,
        driver_id: req.driver.id,
        reported_by: req.user.id,
        issue_type: body.issueType,
        description: body.description,
        reading_at: latest?.recorded_at ?? null,
        latitude: latest?.latitude ?? null,
        longitude: latest?.longitude ?? null,
        temperature_c: latest?.temperature_c ?? null,
        humidity_pct: latest?.humidity_pct ?? null,
      })
      .select(ISSUE_SELECT)
      .single()
  );
  await audit(req, { action: "cold_chain.issue_reported", entityType: "cold_chain_issue", entityId: issue.id, pharmacyId: row.pharmacy_id, details: { issueType: body.issueType } });
  res.status(201).json({ issue: toIssue(issue) });
});

module.exports = router;
