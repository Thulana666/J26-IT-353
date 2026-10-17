// Supabase access shared by the cold-chain routes (service-role client).

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");
const { num } = require("./mappers");
const { planObservedAlerts } = require("./alert-rules");

const LOCATION = "location:locations(name, latitude, longitude)";

const MONITOR_SELECT =
  "shipment_id, pharmacy_id, device_id, storage_condition, temp_min_c, temp_max_c, humidity_min_pct, humidity_max_pct, " +
  "expected_delivery_at, reading_interval_seconds, is_test, monitoring_status, started_at, ended_at, created_at, updated_at, " +
  `pharmacy:pharmacies(id, code, name, ${LOCATION}), ` +
  "device:cold_chain_devices(id, device_code, name, device_type, is_active, last_seen_at), " +
  `shipment:shipments(id, shipment_number, order_id, status, dispatched_at, received_at, warehouse:warehouses(id, code, name, ${LOCATION}), ` +
  "items:shipment_items(id, quantity_shipped, medicine:medicines(id, name, strength, dosage_form, storage_condition), " +
  "batch:batches(id, batch_number, expiry_date)))";

const READING_SELECT =
  "id, recorded_at, received_at, temperature_c, humidity_pct, latitude, longitude, speed_kmh, vibration_g, source, quality_flags";

const ALERT_SELECT =
  "id, shipment_id, pharmacy_id, risk_type, risk_level, basis, risk_probability, title, message, details, dedupe_key, " +
  "first_detected_at, last_detected_at, occurrences, status, acknowledged_by, acknowledged_at, resolved_at, created_at";

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };

async function loadMonitor(shipmentId, select = MONITOR_SELECT) {
  const row = unwrap(await supabase.from("cold_chain_shipments").select(select).eq("shipment_id", shipmentId).maybeSingle());
  if (!row) throw new HttpError(404, "Monitored shipment not found");
  return row;
}

// Newest reading per shipment, newest prediction per shipment, and open alert
// counts, keyed by shipment id (for lists and the detail page).
async function loadShipmentState(shipmentIds) {
  if (shipmentIds.length === 0) return { latest: new Map(), predictions: new Map(), alerts: new Map() };
  const [latest, predictions, alerts] = await Promise.all([
    supabase.from("cold_chain_latest_readings").select(`shipment_id, ${READING_SELECT}`).in("shipment_id", shipmentIds).then(unwrap),
    supabase.from("cold_chain_latest_predictions").select("*").in("shipment_id", shipmentIds).then(unwrap),
    supabase.from("cold_chain_alerts").select("shipment_id, risk_level").in("shipment_id", shipmentIds).neq("status", "resolved").then(unwrap),
  ]);
  const alertSummary = new Map();
  for (const alert of alerts) {
    const summary = alertSummary.get(alert.shipment_id) ?? { count: 0, highestLevel: null };
    summary.count += 1;
    if (!summary.highestLevel || LEVEL_RANK[alert.risk_level] > LEVEL_RANK[summary.highestLevel]) summary.highestLevel = alert.risk_level;
    alertSummary.set(alert.shipment_id, summary);
  }
  return {
    latest: new Map(latest.map((row) => [row.shipment_id, row])),
    predictions: new Map(predictions.map((row) => [row.shipment_id, row])),
    alerts: alertSummary,
  };
}

// The stored reading just before `beforeMs` (for GPS-jump checks across requests).
async function previousReading(shipmentId, beforeMs) {
  const row = unwrap(
    await supabase
      .from("cold_chain_readings")
      .select("recorded_at, latitude, longitude")
      .eq("shipment_id", shipmentId)
      .lt("recorded_at", new Date(beforeMs).toISOString())
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  return row
    ? { recordedAt: Date.parse(row.recorded_at), latitude: num(row.latitude), longitude: num(row.longitude) }
    : null;
}

// Inserts readings; a reading with the same shipment and time as a stored one
// is skipped. Returns the rows actually inserted.
async function insertReadings(rows) {
  return unwrap(
    await supabase
      .from("cold_chain_readings")
      .upsert(rows, { onConflict: "shipment_id,recorded_at", ignoreDuplicates: true })
      .select("id, recorded_at")
  );
}

// Opens, updates and resolves observed-condition alerts for new readings.
// Returns { opened, updated, resolved } counts.
async function recordObservedAlerts(monitor, readings, now = Date.now()) {
  const shipmentId = monitor.shipment_id;
  const [openAlerts, latestRow] = await Promise.all([
    supabase
      .from("cold_chain_alerts")
      .select(ALERT_SELECT)
      .eq("shipment_id", shipmentId)
      .eq("basis", "observed")
      .neq("status", "resolved")
      .then(unwrap),
    supabase
      .from("cold_chain_readings")
      .select("recorded_at, temperature_c, humidity_pct")
      .eq("shipment_id", shipmentId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(unwrap),
  ]);
  const latest = latestRow
    ? { recordedAt: latestRow.recorded_at, temperatureC: num(latestRow.temperature_c), humidityPct: num(latestRow.humidity_pct) }
    : null;
  const limits = {
    tempMinC: num(monitor.temp_min_c),
    tempMaxC: num(monitor.temp_max_c),
    humidityMinPct: num(monitor.humidity_min_pct),
    humidityMaxPct: num(monitor.humidity_max_pct),
  };
  const plan = planObservedAlerts({ readings, latest, openAlerts, limits });
  const nowIso = new Date(now).toISOString();
  const counts = { opened: 0, updated: 0, resolved: plan.resolves.length };

  for (const change of plan.upserts) {
    const row = {
      risk_type: change.riskType,
      risk_level: change.riskLevel,
      title: change.title,
      message: change.message,
      details: change.details,
      first_detected_at: change.firstDetectedAt,
      last_detected_at: change.lastDetectedAt,
      occurrences: change.occurrences,
      ...(change.reopen && { status: "open", acknowledged_by: null, acknowledged_at: null }),
      ...(change.resolve && { status: "resolved", resolved_at: nowIso }),
    };
    if (change.id) {
      unwrap(await supabase.from("cold_chain_alerts").update(row).eq("id", change.id));
      counts.updated += 1;
    } else {
      unwrap(
        await supabase
          .from("cold_chain_alerts")
          .insert({ ...row, shipment_id: shipmentId, basis: "observed", dedupe_key: change.dedupeKey })
      );
      counts.opened += 1;
    }
    if (change.resolve) counts.resolved += 1;
  }
  if (plan.resolves.length) {
    unwrap(
      await supabase
        .from("cold_chain_alerts")
        .update({ status: "resolved", resolved_at: nowIso })
        .in("id", plan.resolves)
        .neq("status", "resolved")
    );
  }
  return counts;
}

// Records an admin action in the shared audit log.
async function audit(req, { action, entityType, entityId = null, pharmacyId = null, details = {} }) {
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: req.user.id,
    pharmacy_id: pharmacyId,
    module: "cold_chain",
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
  if (error) console.error(`[cold-chain] audit log failed: ${error.message}`);
}

module.exports = {
  supabase,
  MONITOR_SELECT,
  READING_SELECT,
  ALERT_SELECT,
  loadMonitor,
  loadShipmentState,
  previousReading,
  insertReadings,
  recordObservedAlerts,
  audit,
};
