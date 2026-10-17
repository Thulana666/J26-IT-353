// Request validation for the cold-chain API. Builds on the pharmacy module's
// Zod helpers, so errors have the same shape:
//   400 { error: "Invalid request", details: { fields: { path: message } } }
// Written to work with both Zod 3 and Zod 4.

const { z, parse, id, int, num, text, bool, optional, nullable } = require("../pharmacy/validation");
const { HttpError } = require("./errors");
const { SENSOR_RANGES, INGEST } = require("./constants");

// ISO 8601 date-time with an explicit time zone, e.g. 2026-10-17T08:30:00Z or +05:30.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

function parseIsoDateTime(value) {
  if (typeof value !== "string" || !ISO_DATETIME_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const isoDateTime = z
  .string()
  .refine((value) => parseIsoDateTime(value) !== null, "must be an ISO 8601 date-time with a time zone")
  .transform((value) => new Date(parseIsoDateTime(value)).toISOString());

// ---------------------------------------------------------------------------
// Sensor readings (from devices)
// ---------------------------------------------------------------------------

// Device time: ISO 8601 with a time zone, or Unix time in seconds (what an
// ESP32 gets from NTP or GPS). Parsed to epoch milliseconds.
const recordedAt = z.any().transform((value, ctx) => {
  const ms =
    typeof value === "number" ? (Number.isFinite(value) ? Math.round(value * 1000) : null) : parseIsoDateTime(value);
  if (ms === null) {
    ctx.addIssue({ code: "custom", message: "must be an ISO 8601 date-time with a time zone, or Unix time in seconds" });
    return z.NEVER;
  }
  return ms;
});

// A JSON number in the sensor's range, or null / absent when not measured.
// Strings are not accepted: a device must send numbers.
const measurement = ([min, max]) =>
  z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`).nullable().optional();

const readingSchema = z
  .object({
    recordedAt,
    temperatureC: measurement(SENSOR_RANGES.temperatureC),
    humidityPct: measurement(SENSOR_RANGES.humidityPct),
    latitude: measurement(SENSOR_RANGES.latitude),
    longitude: measurement(SENSOR_RANGES.longitude),
    speedKmh: measurement(SENSOR_RANGES.speedKmh),
    vibrationG: measurement(SENSOR_RANGES.vibrationG),
  })
  // Unknown fields (e.g. a misspelt "temperature") are errors, not silently dropped.
  .strict()
  .superRefine((reading, ctx) => {
    if (typeof reading.recordedAt !== "number") {
      ctx.addIssue({ code: "custom", path: ["recordedAt"], message: "is required" });
    }
    const hasLat = reading.latitude !== null && reading.latitude !== undefined;
    const hasLng = reading.longitude !== null && reading.longitude !== undefined;
    if (hasLat !== hasLng) {
      ctx.addIssue({ code: "custom", path: [hasLat ? "longitude" : "latitude"], message: "latitude and longitude must be sent together" });
    } else if (hasLat && reading.latitude === 0 && reading.longitude === 0) {
      ctx.addIssue({ code: "custom", path: ["latitude"], message: "0, 0 is not a GPS fix; send null when the GPS has no fix" });
    }
    const hasTemperature = reading.temperatureC !== null && reading.temperatureC !== undefined;
    const hasHumidity = reading.humidityPct !== null && reading.humidityPct !== undefined;
    if (!hasTemperature && !hasHumidity && !hasLat) {
      ctx.addIssue({ code: "custom", path: [], message: "has no temperature, humidity or GPS value" });
    }
  });

const target = {
  shipmentId: id.optional(),
  shipmentNumber: z.string().trim().min(1, "is required").max(40).optional(),
};
const oneTarget = (value) => !(value.shipmentId && value.shipmentNumber);
const oneTargetIssue = { message: "send shipmentId or shipmentNumber, not both", path: ["shipmentNumber"] };

const targetSchema = z.object(target).refine(oneTarget, oneTargetIssue);
const batchSchema = z
  .object({
    ...target,
    readings: z
      .array(z.unknown())
      .min(1, "must contain at least one reading")
      .max(INGEST.maxBatch, `must contain at most ${INGEST.maxBatch} readings`),
  })
  .strict()
  .refine(oneTarget, oneTargetIssue);

// A single reading { recordedAt, ... } or a batch { readings: [...] }; either
// may name the shipment. Returns { target, readings } with readings unchecked.
function parseIngestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  if ("readings" in body) {
    const { readings, ...ref } = parse(batchSchema, body);
    return { target: ref, readings };
  }
  const { shipmentId, shipmentNumber, ...reading } = body;
  return { target: parse(targetSchema, { shipmentId, shipmentNumber }), readings: [reading] };
}

// One reading -> { reading } (recordedAt in epoch ms) or { errors: { field: message } }.
function checkReading(raw) {
  try {
    return { reading: parse(readingSchema, raw) };
  } catch (error) {
    if (error instanceof HttpError && error.details?.fields) return { errors: error.details.fields };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dashboard / admin requests
// ---------------------------------------------------------------------------

const temperature = num(-60, 85);
const humidity = num(0, 100);

const limitFields = {
  tempMinC: optional(temperature),
  tempMaxC: optional(temperature),
  humidityMinPct: nullable(humidity),
  humidityMaxPct: nullable(humidity),
  readingIntervalSeconds: optional(int(5, 3600)),
};

const monitorCreate = z.object({
  shipmentId: id,
  deviceId: optional(id),
  expectedDeliveryAt: optional(isoDateTime),
  // Readings are accepted from this time; default: when the shipment was dispatched.
  startedAt: optional(isoDateTime),
  isTest: bool.optional(),
  ...limitFields,
});

const monitorUpdate = z.object({
  // null unassigns the device.
  deviceId: nullable(id),
  expectedDeliveryAt: nullable(isoDateTime),
  monitoringStatus: z.enum(["ended"]).optional(),
  ...limitFields,
});

const DEVICE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

const deviceCreate = z.object({
  deviceCode: z.string().trim().regex(DEVICE_CODE_RE, "must be 3-40 letters, digits, - or _"),
  name: text(120),
  deviceType: z.enum(["esp32", "simulator"]).optional(),
  notes: text(500),
});

const deviceUpdate = z.object({
  name: nullable(z.string().trim().max(120)),
  notes: nullable(z.string().trim().max(500)),
  isActive: bool.optional(),
});

const listQuery = z.object({
  status: z.enum(["active", "ended"]).optional(),
  test: bool.optional(),
  limit: int(1, 200).optional(),
});

const readingsQuery = z.object({
  from: optional(isoDateTime),
  to: optional(isoDateTime),
  limit: int(1, 5000).optional(),
});

const alertsQuery = z.object({
  status: z.string().max(60).optional(),
  limit: int(1, 500).optional(),
});

module.exports = {
  z,
  parse,
  id,
  parseIngestBody,
  checkReading,
  monitorCreate,
  monitorUpdate,
  deviceCreate,
  deviceUpdate,
  listQuery,
  readingsQuery,
  alertsQuery,
};
