// Validation of sensor readings and cold-chain API requests.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parse,
  parseIngestBody,
  checkReading,
  monitorCreate,
  monitorUpdate,
  deviceCreate,
  readingsQuery,
} = require("../../src/cold-chain/validation");

const ID = "11111111-1111-4111-8111-111111111111";
const T = "2026-10-17T03:00:00Z";
const T_MS = Date.parse(T);

const errorsOf = (raw) => checkReading(raw).errors ?? {};
const status400 = (fn, check = () => true) => assert.throws(fn, (e) => e.status === 400 && check(e.details?.fields ?? {}));

test("a complete reading is accepted; ISO time with an offset and Unix seconds both parse to epoch ms", () => {
  const full = { recordedAt: "2026-10-17T08:30:00+05:30", temperatureC: 5.4, humidityPct: 62.1, latitude: 6.9271, longitude: 79.8612, speedKmh: 38.5, vibrationG: 0.12 };
  assert.deepEqual(checkReading(full).reading, { ...full, recordedAt: T_MS });
  assert.equal(checkReading({ recordedAt: T_MS / 1000, temperatureC: 5 }).reading.recordedAt, T_MS);
});

test("measurements may be null (sensor fault, no GPS fix) but one of temperature, humidity or GPS is needed", () => {
  assert.deepEqual(checkReading({ recordedAt: T, temperatureC: null, humidityPct: 50, latitude: null, longitude: null }).reading, {
    recordedAt: T_MS,
    temperatureC: null,
    humidityPct: 50,
    latitude: null,
    longitude: null,
  });
  assert.ok(checkReading({ recordedAt: T, latitude: 6.9, longitude: 79.8 }).reading);
  assert.match(errorsOf({ recordedAt: T }).body, /no temperature, humidity or GPS/);
  assert.match(errorsOf({ recordedAt: T, temperatureC: null, humidityPct: null }).body, /no temperature/);
});

test("timestamps need a time zone; missing or malformed ones are rejected", () => {
  for (const recordedAt of ["2026-10-17T03:00:00", "2026-10-17 03:00:00Z", "17/10/2026", "", "1792200000", null, undefined, Infinity]) {
    assert.ok(errorsOf({ recordedAt, temperatureC: 5 }).recordedAt, `accepted ${recordedAt}`);
  }
});

test("values outside the sensor ranges, strings and NaN-like values are rejected, never clamped", () => {
  const cases = {
    temperatureC: [-61, 86, "5.2"],
    humidityPct: [-0.1, 100.1],
    latitude: [-91, 91],
    longitude: [-181, 181],
    speedKmh: [-1, 251],
    vibrationG: [-0.1, 16.5],
  };
  for (const [field, values] of Object.entries(cases)) {
    for (const value of values) {
      const raw = { recordedAt: T, temperatureC: 5, latitude: 6.9, longitude: 79.8, [field]: value };
      assert.ok(errorsOf(raw)[field], `${field}=${JSON.stringify(value)} was accepted`);
    }
  }
  assert.ok(checkReading({ recordedAt: T, temperatureC: -60, humidityPct: 100, speedKmh: 0, vibrationG: 16 }).reading);
});

test("GPS: latitude and longitude come together, and 0,0 is not a fix", () => {
  assert.match(errorsOf({ recordedAt: T, temperatureC: 5, latitude: 6.9 }).longitude, /together/);
  assert.match(errorsOf({ recordedAt: T, temperatureC: 5, longitude: 79.8 }).latitude, /together/);
  assert.match(errorsOf({ recordedAt: T, temperatureC: 5, latitude: 0, longitude: 0 }).latitude, /not a GPS fix/);
  assert.ok(checkReading({ recordedAt: T, temperatureC: 5, latitude: 0, longitude: 79.8 }).reading);
});

test("unknown fields are errors, so a misspelt field is not silently dropped", () => {
  assert.match(errorsOf({ recordedAt: T, temperature: 5 }).body, /temperature/);
});

test("ingest body: a single reading or a batch, optionally naming one shipment", () => {
  const single = parseIngestBody({ recordedAt: T, temperatureC: 5 });
  assert.deepEqual(single.readings, [{ recordedAt: T, temperatureC: 5 }]);
  assert.equal(single.target.shipmentId ?? single.target.shipmentNumber, undefined);
  assert.deepEqual(parseIngestBody({ shipmentId: ID, recordedAt: T, temperatureC: 5 }).target.shipmentId, ID);
  const batch = parseIngestBody({ shipmentNumber: " SH-000001 ", readings: [{ a: 1 }, {}] });
  assert.equal(batch.target.shipmentNumber, "SH-000001");
  assert.equal(batch.readings.length, 2);
});

test("ingest body: malformed envelopes are rejected as a whole", () => {
  for (const body of [undefined, null, [], "text", 5]) status400(() => parseIngestBody(body));
  status400(() => parseIngestBody({ readings: [] }), (f) => /at least one/.test(f.readings));
  status400(() => parseIngestBody({ readings: Array.from({ length: 301 }, () => ({})) }), (f) => /at most 300/.test(f.readings));
  status400(() => parseIngestBody({ readings: {} }), (f) => Boolean(f.readings));
  status400(() => parseIngestBody({ readings: [{}], extra: 1 }), (f) => /extra/.test(f.body));
  status400(() => parseIngestBody({ shipmentId: "SH-1", recordedAt: T }), (f) => /valid id/.test(f.shipmentId));
  status400(() => parseIngestBody({ shipmentId: ID, shipmentNumber: "SH-1", readings: [{}] }), (f) => /not both/.test(f.shipmentNumber));
});

test("start monitoring: form strings are coerced, times need a zone and are normalised to UTC", () => {
  const body = parse(monitorCreate, {
    shipmentId: ID,
    tempMinC: "2",
    tempMaxC: "8",
    humidityMaxPct: "",
    readingIntervalSeconds: "30",
    isTest: "true",
    expectedDeliveryAt: "2026-10-18T14:30:00+05:30",
  });
  assert.deepEqual(body, {
    shipmentId: ID,
    tempMinC: 2,
    tempMaxC: 8,
    humidityMaxPct: null,
    readingIntervalSeconds: 30,
    isTest: true,
    expectedDeliveryAt: "2026-10-18T09:00:00.000Z",
  });
  status400(() => parse(monitorCreate, { shipmentId: ID, expectedDeliveryAt: "2026-10-18T14:30" }), (f) => /time zone/.test(f.expectedDeliveryAt));
  status400(() => parse(monitorCreate, { shipmentId: ID, readingIntervalSeconds: 1 }), (f) => /at least 5/.test(f.readingIntervalSeconds));
  status400(() => parse(monitorCreate, {}), (f) => Boolean(f.shipmentId));
});

test("update monitoring: null unassigns the device; only 'ended' is an allowed status change", () => {
  assert.deepEqual(parse(monitorUpdate, { deviceId: null, monitoringStatus: "ended" }), { deviceId: null, monitoringStatus: "ended" });
  status400(() => parse(monitorUpdate, { monitoringStatus: "active" }), (f) => Boolean(f.monitoringStatus));
});

test("device codes are 3-40 letters, digits, - or _", () => {
  assert.equal(parse(deviceCreate, { deviceCode: " ESP32-001 " }).deviceCode, "ESP32-001");
  for (const deviceCode of ["ab", "-ESP", "ESP 32", "ESP32/1", "x".repeat(41)]) {
    status400(() => parse(deviceCreate, { deviceCode }), (f) => Boolean(f.deviceCode));
  }
  status400(() => parse(deviceCreate, { deviceCode: "ESP32-001", deviceType: "arduino" }), (f) => Boolean(f.deviceType));
});

test("readings query: limits and ISO ranges", () => {
  assert.deepEqual(parse(readingsQuery, { limit: "500", from: T }), { limit: 500, from: "2026-10-17T03:00:00.000Z" });
  status400(() => parse(readingsQuery, { limit: "5001" }), (f) => Boolean(f.limit));
  status400(() => parse(readingsQuery, { to: "yesterday" }), (f) => Boolean(f.to));
});
