// Limits and settings for cold-chain monitoring (Component 2).

const STORAGE_CONDITIONS = ["ambient", "cool", "refrigerated", "frozen"];

// Strictest first: a shipment is monitored for its strictest item.
const STRICTNESS = ["frozen", "refrigerated", "cool", "ambient"];

// Default limits per storage condition (medicines.storage_condition; the
// temperature bands match the warehouse schema). Prototype defaults, not
// regulatory limits: each shipment's limits can be changed to match the
// product labels. Humidity is not limited by default for frozen goods.
const DEFAULT_LIMITS = {
  frozen: { tempMinC: -25, tempMaxC: -15, humidityMinPct: null, humidityMaxPct: null },
  refrigerated: { tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 },
  cool: { tempMinC: 8, tempMaxC: 15, humidityMinPct: null, humidityMaxPct: 65 },
  ambient: { tempMinC: 15, tempMaxC: 30, humidityMinPct: null, humidityMaxPct: 65 },
};

// A temperature this close to a limit raises a medium "approaching" alert.
const TEMP_WARNING_MARGIN_C = 0.5;

const RISK_TYPES = [
  "temperature_excursion",
  "humidity_deviation",
  "delivery_delay",
  "route_anomaly",
  "communication_gap",
  "combined",
];
const RISK_LEVELS = ["low", "medium", "high"];
const ALERT_STATUSES = ["open", "acknowledged", "resolved"];

// Physical ranges accepted from sensors (SHT31, NEO-6M, MPU6050 at +-16 g).
// Values outside are rejected as sensor or transmission errors.
const SENSOR_RANGES = {
  temperatureC: [-60, 85],
  humidityPct: [0, 100],
  latitude: [-90, 90],
  longitude: [-180, 180],
  speedKmh: [0, 250],
  vibrationG: [0, 16],
};

const INGEST = {
  // Readings per request (a device uploading its buffer after a gap).
  maxBatch: 300,
  // Device clocks may run slightly ahead of the server.
  maxClockAheadMs: 2 * 60 * 1000,
  // Earlier timestamps mean the device clock was never set (no NTP/GPS time).
  earliestValid: Date.parse("2020-01-01T00:00:00Z"),
  // Uploaded later than this (or 3 reading intervals) -> 'delayed_upload'.
  delayedUploadMs: 5 * 60 * 1000,
  // Consecutive GPS fixes implying more than this speed -> 'gps_jump'.
  maxPlausibleSpeedKmh: 200,
  // GPS jitter below this distance is never a jump.
  minJumpDistanceKm: 1,
};

// Connection status from the age of the newest reading, in reading intervals.
const CONNECTION = { onlineIntervals: 3, delayedIntervals: 10 };

// Trip workflow (cold_chain_shipments.trip_status) and fleet statuses.
const TRIP_STATUSES = ["ready_for_dispatch", "allocated", "in_transit", "delivered"];
const DRIVER_STATUSES = ["available", "assigned", "on_trip", "inactive"];
const TRUCK_STATUSES = ["available", "assigned", "in_use", "inactive"];
const TRUCK_TYPES = ["refrigerated_truck", "refrigerated_van", "insulated_van", "standard_truck", "standard_van"];
// Problems a driver can report from the Driver Portal, and their handling.
const ISSUE_TYPES = ["vehicle", "temperature", "gps", "delay", "pharmacy_unavailable", "damaged", "route", "other"];
const ISSUE_STATUSES = ["open", "in_review", "resolved"];

// Risk levels from a probability: below 0.3 low, below 0.7 medium, else high.
const RISK_THRESHOLDS = { medium: 0.3, high: 0.7 };
// Predicted alerts open at this probability and resolve below CLOSE (hysteresis,
// so a value hovering around one threshold does not open and close repeatedly).
const PREDICTED_ALERT = { open: 0.6, high: 0.8, close: 0.4, combinedOpen: 0.7, combinedClose: 0.5 };
// A new prediction is stored when the level changes, the probability moves by
// at least `minChange`, or `maxAgeMinutes` passed since the last stored one.
const PREDICTION_STORE = { minChange: 0.05, maxAgeMinutes: 5 };

module.exports = {
  TRIP_STATUSES,
  DRIVER_STATUSES,
  TRUCK_STATUSES,
  TRUCK_TYPES,
  ISSUE_TYPES,
  ISSUE_STATUSES,
  RISK_THRESHOLDS,
  PREDICTED_ALERT,
  PREDICTION_STORE,
  STORAGE_CONDITIONS,
  STRICTNESS,
  DEFAULT_LIMITS,
  TEMP_WARNING_MARGIN_C,
  RISK_TYPES,
  RISK_LEVELS,
  ALERT_STATUSES,
  SENSOR_RANGES,
  INGEST,
  CONNECTION,
};
