// Runs the risk predictor for a trip in transit, stores the prediction and
// keeps the predicted-risk alerts up to date. Called after new readings, when
// a trip starts, and by the scheduler (so delays and silent sensors are
// noticed even when no readings arrive).

const supabase = require("../../config/supabase");
const { unwrap } = require("../errors");
const { num } = require("../mappers");
const { applyAlertPlan } = require("../store");
const { PREDICTION_STORE } = require("../constants");
const { getRiskProvider } = require("./provider");
const { planPredictedAlerts } = require("./predicted-alerts");

const MIN = 60_000;
// Readings given to the predictor (the prototype uses the last hour).
const WINDOW_MINUTES = 90;

const TRIP_SELECT =
  "shipment_id, trip_status, temp_min_c, temp_max_c, humidity_min_pct, humidity_max_pct, expected_delivery_at, " +
  "reading_interval_seconds, trip_started_at, pharmacy:pharmacies(location:locations(latitude, longitude))";

async function loadInput(shipmentId, now) {
  const trip = unwrap(await supabase.from("cold_chain_shipments").select(TRIP_SELECT).eq("shipment_id", shipmentId).maybeSingle());
  if (!trip || trip.trip_status !== "in_transit") return null;
  const rows = unwrap(
    await supabase
      .from("cold_chain_readings")
      .select("recorded_at, temperature_c, humidity_pct, latitude, longitude, speed_kmh, quality_flags")
      .eq("shipment_id", shipmentId)
      .gte("recorded_at", new Date(now - WINDOW_MINUTES * MIN).toISOString())
      .order("recorded_at", { ascending: true })
      .limit(1000)
  );
  const location = trip.pharmacy?.location;
  return {
    readings: rows.map((r) => ({
      recordedAt: Date.parse(r.recorded_at),
      temperatureC: num(r.temperature_c),
      humidityPct: num(r.humidity_pct),
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      speedKmh: num(r.speed_kmh),
      qualityFlags: r.quality_flags ?? [],
    })),
    limits: {
      tempMinC: num(trip.temp_min_c),
      tempMaxC: num(trip.temp_max_c),
      humidityMinPct: num(trip.humidity_min_pct),
      humidityMaxPct: num(trip.humidity_max_pct),
    },
    trip: { expectedDeliveryAt: trip.expected_delivery_at, startedAt: trip.trip_started_at, intervalSeconds: trip.reading_interval_seconds },
    destination:
      location?.latitude != null && location?.longitude != null ? { latitude: num(location.latitude), longitude: num(location.longitude) } : null,
    now,
  };
}

// Stores the prediction unless it repeats the last stored one (same level and
// main risk type, probability within PREDICTION_STORE.minChange, less than
// maxAgeMinutes old).
async function storePrediction(shipmentId, prediction, now) {
  const last = unwrap(
    await supabase
      .from("cold_chain_risk_predictions")
      .select("risk_level, risk_type, risk_probability, predicted_at")
      .eq("shipment_id", shipmentId)
      .order("predicted_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  );
  const repeats =
    last &&
    last.risk_level === prediction.riskLevel &&
    (last.risk_type ?? null) === (prediction.riskType ?? null) &&
    Math.abs(num(last.risk_probability) - prediction.riskProbability) < PREDICTION_STORE.minChange &&
    now - Date.parse(last.predicted_at) < PREDICTION_STORE.maxAgeMinutes * MIN;
  if (repeats) return false;
  unwrap(
    await supabase.from("cold_chain_risk_predictions").insert({
      shipment_id: shipmentId,
      model_name: prediction.modelName,
      model_version: prediction.modelVersion ?? "unknown",
      is_prototype: prediction.isPrototype,
      risk_level: prediction.riskLevel,
      risk_probability: prediction.riskProbability,
      risk_type: prediction.riskType,
      explanation: prediction.explanation,
      factors: prediction.factors ?? {},
      horizon_minutes: prediction.horizonMinutes,
      readings_used: prediction.readingsUsed,
      data_until: prediction.dataUntil,
      predicted_at: new Date(now).toISOString(),
    })
  );
  return true;
}

async function recordPredictedAlerts(shipmentId, prediction, now) {
  const open = unwrap(
    await supabase
      .from("cold_chain_alerts")
      .select("id, dedupe_key, risk_type, risk_level, basis, status, first_detected_at, last_detected_at, occurrences")
      .eq("shipment_id", shipmentId)
      .neq("status", "resolved")
  );
  const observedOpen = Object.fromEntries(
    open.filter((a) => a.basis === "observed" && a.risk_level === "high").map((a) => [a.risk_type, true])
  );
  // A humidity reading outside its range is a medium observed alert: it still suppresses the prediction.
  for (const a of open) if (a.basis === "observed" && a.risk_type === "humidity_deviation") observedOpen.humidity_deviation = true;
  const plan = planPredictedAlerts({ prediction, openAlerts: open.filter((a) => a.basis === "predicted"), observedOpen, now });
  return applyAlertPlan(shipmentId, "predicted", plan, now);
}

// Returns the prediction (or null when the trip is not in transit).
async function evaluateRisk(shipmentId, { now = Date.now() } = {}) {
  const input = await loadInput(shipmentId, now);
  if (!input) return null;
  const prediction = await getRiskProvider().predict(input);
  const stored = await storePrediction(shipmentId, prediction, now);
  const alerts = await recordPredictedAlerts(shipmentId, prediction, now);
  return { ...prediction, stored, alerts };
}

module.exports = { evaluateRisk };
