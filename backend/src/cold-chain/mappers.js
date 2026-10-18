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

function toDriver(row, activeTrip) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    ...(row.licence_number !== undefined && {
      email: row.email ?? null,
      licenceNumber: row.licence_number,
      licenceExpiry: row.licence_expiry,
      notes: row.notes ?? null,
      createdAt: row.created_at,
    }),
    status: row.status,
    ...(row.account !== undefined && { account: row.account ? { email: row.account.email, status: row.account.status } : null }),
    ...(activeTrip !== undefined && { activeTrip }),
  };
}

function toIssue(row, names = new Map()) {
  return {
    id: row.id,
    shipmentId: row.shipment_id,
    issueType: row.issue_type,
    description: row.description,
    status: row.status,
    driverName: row.driver?.full_name ?? null,
    reportedAt: row.created_at,
    snapshot: row.reading_at
      ? { readingAt: row.reading_at, latitude: num(row.latitude), longitude: num(row.longitude), temperatureC: num(row.temperature_c), humidityPct: num(row.humidity_pct) }
      : null,
    resolutionNotes: row.resolution_notes ?? null,
    resolvedBy: names.get(row.resolved_by) ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}

function toTruck(row, activeTrip) {
  if (!row) return null;
  return {
    id: row.id,
    registrationNumber: row.registration_number,
    truckType: row.truck_type,
    isRefrigerated: row.is_refrigerated,
    minTempC: num(row.min_temp_c),
    maxTempC: num(row.max_temp_c),
    status: row.status,
    ...(row.device !== undefined && { device: row.device ? { id: row.device.id, deviceCode: row.device.device_code, deviceType: row.device.device_type, isActive: row.device.is_active } : null }),
    ...(row.notes !== undefined && { notes: row.notes ?? null, createdAt: row.created_at }),
    ...(activeTrip !== undefined && { activeTrip }),
  };
}

function toTrip(row) {
  const started = row.trip_started_at ? Date.parse(row.trip_started_at) : null;
  const delivered = row.delivered_at ? Date.parse(row.delivered_at) : null;
  return {
    status: row.trip_status ?? null,
    allocatedAt: row.allocated_at ?? null,
    startedAt: row.trip_started_at ?? null,
    deliveredAt: row.delivered_at ?? null,
    durationMinutes: started !== null && delivered !== null ? Math.round((delivered - started) / 60_000) : null,
    deliveryNotes: row.delivery_notes ?? null,
    final: row.delivered_at
      ? {
          readingAt: row.final_reading_at ?? null,
          temperatureC: num(row.final_temperature_c),
          humidityPct: num(row.final_humidity_pct),
          latitude: num(row.final_latitude),
          longitude: num(row.final_longitude),
        }
      : null,
  };
}

function toSummary(row) {
  if (!row) return null;
  return {
    readings: row.readings ?? 0,
    firstReadingAt: row.first_reading_at,
    lastReadingAt: row.last_reading_at,
    temperature: { min: num(row.temperature_min), max: num(row.temperature_max), avg: num(row.temperature_avg), outside: row.temperature_outside ?? 0 },
    humidity: { min: num(row.humidity_min), max: num(row.humidity_max), avg: num(row.humidity_avg), outside: row.humidity_outside ?? 0 },
    alerts: row.alerts ?? 0,
    highAlerts: row.high_alerts ?? 0,
    maxRiskProbability: num(row.max_risk_probability),
  };
}

// A monitored shipment with its Component 4 details (route, items, delivery)
// and its trip (driver, truck, workflow status).
// extras: { latest (reading row), prediction (row), openAlerts: { count, highestLevel }, summary (row), now }
function toMonitor(row, { latest = null, prediction = null, openAlerts = null, summary = null, now = Date.now() } = {}) {
  const shipment = row.shipment ?? {};
  return {
    shipmentId: row.shipment_id,
    shipmentNumber: shipment.shipment_number ?? null,
    orderId: shipment.order_id ?? null,
    orderNumber: shipment.purchase_order?.order_number ?? null,
    trip: toTrip(row),
    driver: toDriver(row.driver ?? null),
    truck: toTruck(row.truck ?? null),
    summary: toSummary(summary),
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

module.exports = { num, toDevice, toDriver, toTruck, toIssue, toReading, toAlert, toPrediction, toMonitor, toLimits, toSummary };
