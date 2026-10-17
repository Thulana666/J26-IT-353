// Database rows -> API objects (camelCase).

const { connectionStatus, deliveryStatus } = require("./monitoring");

// PostgREST returns numeric columns as numbers or strings depending on size.
const num = (value) => (value === null || value === undefined ? null : Number(value));

const toLocation = (location) =>
  location ? { name: location.name, latitude: num(location.latitude), longitude: num(location.longitude) } : null;

function toLimits(row) {
  return {
    storageCondition: row.storage_condition,
    tempMinC: num(row.temp_min_c),
    tempMaxC: num(row.temp_max_c),
    humidityMinPct: num(row.humidity_min_pct),
    humidityMaxPct: num(row.humidity_max_pct),
  };
}

function toDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    deviceCode: row.device_code,
    name: row.name ?? null,
    deviceType: row.device_type,
    isActive: row.is_active,
    lastSeenAt: row.last_seen_at ?? null,
    ...(row.notes !== undefined && { notes: row.notes }),
    ...(row.created_at !== undefined && { createdAt: row.created_at }),
  };
}

function toReading(row) {
  return {
    id: row.id,
    recordedAt: row.recorded_at,
    receivedAt: row.received_at,
    temperatureC: num(row.temperature_c),
    humidityPct: num(row.humidity_pct),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    speedKmh: num(row.speed_kmh),
    vibrationG: num(row.vibration_g),
    source: row.source,
    qualityFlags: row.quality_flags ?? [],
  };
}

function toAlert(row, names = new Map()) {
  return {
    id: row.id,
    shipmentId: row.shipment_id,
    riskType: row.risk_type,
    riskLevel: row.risk_level,
    basis: row.basis,
    riskProbability: num(row.risk_probability),
    title: row.title,
    message: row.message,
    details: row.details ?? {},
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    occurrences: row.occurrences,
    status: row.status,
    acknowledgedBy: names.get(row.acknowledged_by) ?? null,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function toPrediction(row) {
  if (!row) return null;
  return {
    id: row.id,
    modelName: row.model_name,
    modelVersion: row.model_version,
    isPrototype: row.is_prototype,
    riskLevel: row.risk_level,
    riskProbability: num(row.risk_probability),
    riskType: row.risk_type,
    explanation: row.explanation,
    factors: row.factors ?? {},
    horizonMinutes: row.horizon_minutes,
    readingsUsed: row.readings_used,
    dataUntil: row.data_until,
    predictedAt: row.predicted_at,
  };
}

// A monitored shipment with its Component 4 details (route, items, delivery).
// extras: { latest (reading row), prediction (row), openAlerts: { count, highestLevel }, now }
function toMonitor(row, { latest = null, prediction = null, openAlerts = null, now = Date.now() } = {}) {
  const shipment = row.shipment ?? {};
  return {
    shipmentId: row.shipment_id,
    shipmentNumber: shipment.shipment_number ?? null,
    orderId: shipment.order_id ?? null,
    origin: shipment.warehouse
      ? { warehouseId: shipment.warehouse.id, code: shipment.warehouse.code, name: shipment.warehouse.name, location: toLocation(shipment.warehouse.location) }
      : null,
    destination: row.pharmacy
      ? { pharmacyId: row.pharmacy.id, code: row.pharmacy.code, name: row.pharmacy.name, location: toLocation(row.pharmacy.location) }
      : null,
    items: (shipment.items ?? []).map((item) => ({
      id: item.id,
      quantityShipped: item.quantity_shipped,
      medicineId: item.medicine?.id ?? null,
      medicineName: item.medicine?.name ?? null,
      strength: item.medicine?.strength ?? null,
      dosageForm: item.medicine?.dosage_form ?? null,
      storageCondition: item.medicine?.storage_condition ?? null,
      batchNumber: item.batch?.batch_number ?? null,
      expiryDate: item.batch?.expiry_date ?? null,
    })),
    device: toDevice(row.device),
    limits: toLimits(row),
    readingIntervalSeconds: row.reading_interval_seconds,
    isTest: row.is_test,
    monitoringStatus: row.monitoring_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    delivery: deliveryStatus({
      shipmentStatus: shipment.status ?? null,
      dispatchedAt: shipment.dispatched_at ?? null,
      expectedDeliveryAt: row.expected_delivery_at,
      receivedAt: shipment.received_at ?? null,
      now,
    }),
    connection: connectionStatus({
      lastReadingAt: latest?.recorded_at ?? null,
      intervalSeconds: row.reading_interval_seconds,
      monitoringStatus: row.monitoring_status,
      now,
    }),
    latestReading: latest ? toReading(latest) : null,
    latestPrediction: toPrediction(prediction),
    openAlerts: openAlerts ?? { count: 0, highestLevel: null },
  };
}

module.exports = { num, toDevice, toReading, toAlert, toPrediction, toMonitor, toLimits };
