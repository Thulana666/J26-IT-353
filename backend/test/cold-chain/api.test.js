// HTTP tests of the cold-chain API with a fake Supabase client: device keys,
// ingestion (partial batches, duplicates, test-data separation, alerts) and
// user access. Database behaviour itself is covered by database.test.mjs.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supabase = require("../../src/config/supabase");
const { installFakeSupabase, filterValue } = require("./fake-supabase");
const { coldChainRouter } = require("../../src/cold-chain");
const { generateDeviceKey, hashDeviceKey } = require("../../src/cold-chain/device-auth");

const PH1 = "11111111-1111-4111-8111-111111111111";
const PH2 = "22222222-2222-4222-8222-222222222222";
const SHIPMENT_ID = "33333333-3333-4333-8333-333333333333";
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const KEY = generateDeviceKey();
const DEVICE = {
  id: "dev-1",
  device_code: "ESP32-001",
  name: null,
  device_type: "esp32",
  key_hash: hashDeviceKey(KEY),
  is_active: true,
  last_seen_at: null,
};

let respond = () => null;
const log = installFakeSupabase(supabase, (query) => respond(query));
const queries = (table, op) => log.filter((q) => q.table === table && (!op || q.op === op));

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cold-chain", coldChainRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/cold-chain`;
});
after(() => server.close());

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const DEVICE_HEADERS = { "x-device-id": "ESP32-001", "x-device-key": KEY };
const postReadings = (body, headers = DEVICE_HEADERS) => call("/readings", { method: "POST", body, headers });

const monitor = (overrides = {}) => ({
  shipment_id: SHIPMENT_ID,
  device_id: "dev-1",
  temp_min_c: 2,
  temp_max_c: 8,
  humidity_min_pct: null,
  humidity_max_pct: 85,
  reading_interval_seconds: 60,
  is_test: false,
  monitoring_status: "active",
  trip_status: "in_transit",
  started_at: iso(Date.now() - 24 * 60 * MIN),
  ended_at: null,
  shipment: { shipment_number: "SH-000001", received_at: null },
  ...overrides,
});

// A device-side world: the device, its assignments, readings already stored
// (by recorded_at ISO), the newest stored reading and an optional alert failure.
function deviceWorld({ device = DEVICE, monitors = [monitor()], stored = [], latest = null, alertsError = null } = {}) {
  log.length = 0;
  respond = (q) => {
    if (q.table === "cold_chain_devices" && q.op === "select") {
      return { data: filterValue(q, "eq", "device_code") === device.device_code ? device : null, error: null };
    }
    if (q.table === "cold_chain_devices" && q.op === "update") return { data: null, error: null };
    if (q.table === "cold_chain_shipments" && q.single === "maybe") {
      const [m] = monitors;
      return {
        data: m && { ...m, expected_delivery_at: null, trip_started_at: iso(Date.now() - 2 * MIN), pharmacy: { location: null } },
        error: null,
      };
    }
    if (q.table === "cold_chain_shipments") return { data: monitors, error: null };
    if (q.table === "cold_chain_risk_predictions") return { data: null, error: null };
    if (q.table === "cold_chain_readings" && q.op === "upsert") {
      const inserted = q.payload.filter((row) => !stored.includes(row.recorded_at));
      // PostgREST answers with +00:00 offsets rather than Z.
      return { data: inserted.map((row, i) => ({ id: i + 1, recorded_at: row.recorded_at.replace("Z", "+00:00") })), error: null };
    }
    if (q.table === "cold_chain_readings" && q.op === "select" && filterValue(q, "gte", "recorded_at")) {
      return { data: [], error: null };
    }
    if (q.table === "cold_chain_readings" && q.op === "select") {
      return { data: filterValue(q, "lt", "recorded_at") ? null : latest, error: null };
    }
    if (q.table === "cold_chain_alerts" && q.op === "select") {
      return alertsError ? { data: null, error: alertsError } : { data: [], error: null };
    }
    if (q.table === "cold_chain_alerts" && q.op === "insert") return { data: null, error: null };
    throw new Error(`unexpected query: ${q.op} ${q.table}`);
  };
}

describe("device keys", () => {
  test("keys are random, prefixed and stored only as a SHA-256 hash", () => {
    const a = generateDeviceKey();
    assert.match(a, /^ccd_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, generateDeviceKey());
    assert.match(hashDeviceKey(a), /^[0-9a-f]{64}$/);
    assert.equal(hashDeviceKey(a), hashDeviceKey(a));
  });

  test("missing, unknown or wrong credentials get 401; a deactivated device gets 403", async () => {
    deviceWorld();
    const reading = { recordedAt: iso(Date.now()), temperatureC: 5 };
    assert.equal((await postReadings(reading, {})).status, 401);
    assert.equal((await postReadings(reading, { "x-device-id": "ESP32-001" })).status, 401);
    const unknown = await postReadings(reading, { "x-device-id": "ESP32-999", "x-device-key": KEY });
    const wrongKey = await postReadings(reading, { "x-device-id": "ESP32-001", "x-device-key": generateDeviceKey() });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, wrongKey.body, "unknown device and wrong key look the same");
    assert.equal(queries("cold_chain_readings").length, 0);

    deviceWorld({ device: { ...DEVICE, is_active: false } });
    assert.equal((await postReadings(reading)).status, 403);
  });
});

describe("POST /readings", () => {
  test("a valid reading is stored with the device, server time and data-quality flags", async () => {
    const now = Date.now();
    deviceWorld({ latest: { recorded_at: iso(now - MIN), temperature_c: 5, humidity_pct: 60 } });
    const { status, body } = await postReadings({ recordedAt: Math.floor((now - 10 * MIN) / 1000), temperatureC: 5.25, latitude: 6.9271, longitude: 79.8612 });
    assert.equal(status, 201);
    const { risk, ...rest } = body;
    assert.deepEqual(rest, { shipmentId: SHIPMENT_ID, shipmentNumber: "SH-000001", accepted: 1, duplicates: [], rejected: [], alerts: { opened: 0, updated: 0, resolved: 0 } });
    // The temporary predictor ran on the new readings and says so.
    assert.equal(risk.isPrototype, true);
    assert.equal(risk.riskLevel, "low");
    assert.equal(queries("cold_chain_risk_predictions", "insert")[0].payload.is_prototype, true);

    const [upsert] = queries("cold_chain_readings", "upsert");
    assert.deepEqual(upsert.options, { onConflict: "shipment_id,recorded_at", ignoreDuplicates: true });
    const [row] = upsert.payload;
    assert.equal(row.device_id, "dev-1");
    assert.equal(row.source, "device");
    assert.equal(row.temperature_c, 5.25);
    assert.equal(row.humidity_pct, null);
    assert.deepEqual(row.quality_flags, ["delayed_upload"], "recorded 10 minutes before upload");
    assert.ok(Date.parse(row.received_at) >= now);
    assert.equal(queries("cold_chain_devices", "update").length, 1, "last_seen_at is updated");
  });

  test("a batch keeps valid readings, reports duplicates and rejects bad ones with reasons", async () => {
    const now = Date.now();
    const t = (minutesAgo) => iso(now - minutesAgo * MIN);
    deviceWorld({ stored: [t(1)], latest: { recorded_at: t(1), temperature_c: 9.0, humidity_pct: 60 } });
    const { status, body } = await postReadings({
      shipmentNumber: "SH-000001",
      readings: [
        { recordedAt: t(3), temperatureC: 5 },
        { recordedAt: t(3), temperatureC: "hot" },
        { recordedAt: t(2), temperatureC: 9.3 },
        { recordedAt: t(2), temperatureC: 9.3 },
        { recordedAt: t(1), temperatureC: 9.0 },
        { recordedAt: iso(now - 48 * 60 * MIN), temperatureC: 5 },
      ],
    });
    assert.equal(status, 201);
    assert.equal(body.accepted, 2);
    assert.deepEqual(body.duplicates.sort(), [t(2), t(1)].sort(), "same time in the batch, and already stored");
    assert.deepEqual(body.rejected.map((r) => r.index), [1, 5]);
    assert.ok(body.rejected[0].errors.temperatureC);
    assert.match(body.rejected[1].errors.recordedAt, /before monitoring/);

    const [upsert] = queries("cold_chain_readings", "upsert");
    assert.deepEqual(upsert.payload.map((r) => r.recorded_at), [t(3), t(2), t(1)], "sorted, without the in-batch duplicate");
    assert.equal(filterValue(queries("cold_chain_shipments")[0], "eq", "shipment.shipment_number"), "SH-000001");

    // 9.3 °C is above the 8 °C limit: one observed alert, still active (newest reading 9.0 °C).
    assert.deepEqual(body.alerts, { opened: 1, updated: 0, resolved: 0 });
    const [alert] = queries("cold_chain_alerts", "insert").map((q) => q.payload).filter((a) => a.basis === "observed");
    assert.equal(alert.shipment_id, SHIPMENT_ID);
    assert.equal(alert.basis, "observed");
    assert.equal(alert.dedupe_key, "temperature_excursion:above");
    assert.equal(alert.risk_level, "high");
    assert.equal(alert.occurrences, 1, "only newly stored readings count");
    assert.equal(alert.status, undefined, "opens with the default status");
  });

  test("only duplicates: 200, nothing new stored, no alert evaluation", async () => {
    const t = iso(Date.now() - MIN);
    deviceWorld({ stored: [t] });
    const { status, body } = await postReadings({ recordedAt: t, temperatureC: 5 });
    assert.equal(status, 200);
    assert.deepEqual([body.accepted, body.duplicates, body.alerts], [0, [t], null]);
    assert.equal(queries("cold_chain_alerts").length, 0);
  });

  test("nothing valid: 400 with the reason for each reading", async () => {
    deviceWorld();
    const { status, body } = await postReadings({
      readings: [{ recordedAt: "yesterday", temperatureC: 5 }, { recordedAt: iso(Date.now()), latitude: 0, longitude: 0 }],
    });
    assert.equal(status, 400);
    assert.equal(body.error, "No valid readings");
    assert.equal(body.details.rejected.length, 2);
    assert.match(body.details.rejected[1].errors.latitude, /not a GPS fix/);
    assert.equal(queries("cold_chain_readings", "upsert").length, 0);
  });

  test("malformed JSON and malformed envelopes are rejected", async () => {
    deviceWorld();
    const bad = await postReadings("{ not json");
    assert.deepEqual([bad.status, bad.body.error], [400, "Request body is not valid JSON"]);
    assert.equal((await postReadings({ readings: [] })).status, 400);
  });

  test("a device without an assignment, or naming another shipment, gets 409", async () => {
    deviceWorld({ monitors: [] });
    const reading = { recordedAt: iso(Date.now()), temperatureC: 5 };
    const none = await postReadings(reading);
    assert.deepEqual([none.status, none.body.error], [409, "This device is not assigned to an active shipment"]);
    const other = await postReadings({ ...reading, shipmentId: SHIPMENT_ID });
    assert.deepEqual([other.status, other.body.error], [409, "This device is not assigned to that shipment"]);
  });

  test("readings for a trip that is not in transit yet are refused (409)", async () => {
    for (const tripStatus of ["ready_for_dispatch", "allocated"]) {
      deviceWorld({ monitors: [monitor({ trip_status: tripStatus })] });
      const { status, body } = await postReadings({ recordedAt: iso(Date.now()), temperatureC: 5 });
      assert.deepEqual([status, body.error], [409, "The trip of shipment SH-000001 has not started yet"]);
      assert.equal(queries("cold_chain_readings", "upsert").length, 0);
    }
  });

  test("simulated data only reaches test shipments and is stored as 'simulator'", async () => {
    const simulator = { ...DEVICE, device_type: "simulator" };
    const reading = { recordedAt: iso(Date.now()), temperatureC: 5 };
    deviceWorld({ device: simulator });
    const refused = await postReadings(reading);
    assert.deepEqual([refused.status, refused.body.error], [409, "A simulator can only report for test shipments"]);

    deviceWorld({ device: simulator, monitors: [monitor({ is_test: true })] });
    assert.equal((await postReadings(reading)).status, 201);
    assert.equal(queries("cold_chain_readings", "upsert")[0].payload[0].source, "simulator");
  });

  test("a failed alert evaluation does not fail the upload (the readings are stored)", async (t) => {
    t.mock.method(console, "error", () => {});
    deviceWorld({ alertsError: { code: "XX000", message: "boom" } });
    const { status, body } = await postReadings({ recordedAt: iso(Date.now()), temperatureC: 9 });
    assert.equal(status, 201);
    assert.deepEqual([body.accepted, body.alerts], [1, null]);
  });
});

describe("user routes", () => {
  const monitorRow = (pharmacyId) => ({
    shipment_id: SHIPMENT_ID,
    pharmacy_id: pharmacyId,
    device_id: "dev-1",
    storage_condition: "refrigerated",
    temp_min_c: 2,
    temp_max_c: 8,
    humidity_min_pct: null,
    humidity_max_pct: "85.00",
    expected_delivery_at: iso(Date.now() - 30 * MIN),
    reading_interval_seconds: 60,
    is_test: false,
    monitoring_status: "active",
    started_at: iso(Date.now() - 5 * 60 * MIN),
    ended_at: null,
    pharmacy: { id: pharmacyId, code: "SAMPLE-PH-COL", name: "Colombo pharmacy", location: { name: "Colombo", latitude: "6.927100", longitude: "79.861200" } },
    device: { id: "dev-1", device_code: "ESP32-001", name: null, device_type: "esp32", is_active: true, last_seen_at: null },
    shipment: {
      id: SHIPMENT_ID,
      shipment_number: "SH-000001",
      order_id: "order-1",
      status: "in_transit",
      dispatched_at: iso(Date.now() - 5 * 60 * MIN),
      received_at: null,
      warehouse: { id: "wh-1", code: "WH", name: "Central warehouse", location: null },
      items: [
        {
          id: "item-1",
          quantity_shipped: 2,
          medicine: { id: "med-1", name: "Insulin (soluble)", strength: "100 IU/mL", dosage_form: "injection", storage_condition: "refrigerated" },
          batch: { id: "b-1", batch_number: "INS-001", expiry_date: "2027-06-30" },
        },
      ],
    },
  });

  function userWorld({ role, pharmacyId = null, monitorPharmacy = PH1 }) {
    log.length = 0;
    supabase.auth.getClaims = async () => ({ data: { claims: { sub: "user-1" } }, error: null });
    respond = (q) => {
      if (q.table === "profiles") {
        return { data: { id: "user-1", email: "u@test.local", full_name: "U", role, status: "active", pharmacy_id: pharmacyId }, error: null };
      }
      if (q.table === "cold_chain_shipments") return { data: monitorRow(monitorPharmacy), error: null };
      if (q.table === "cold_chain_latest_readings") {
        return { data: [{ shipment_id: SHIPMENT_ID, id: 7, recorded_at: iso(Date.now() - 30_000), received_at: iso(Date.now()), temperature_c: "7.80", humidity_pct: "61.00", latitude: null, longitude: null, speed_kmh: null, vibration_g: null, source: "device", quality_flags: [] }], error: null };
      }
      if (q.table === "cold_chain_latest_predictions") return { data: [], error: null };
      if (q.table === "cold_chain_shipment_summaries") return { data: [], error: null };
      if (q.table === "cold_chain_alerts") {
        return { data: [{ shipment_id: SHIPMENT_ID, risk_level: "medium" }, { shipment_id: SHIPMENT_ID, risk_level: "high" }], error: null };
      }
      throw new Error(`unexpected query: ${q.op} ${q.table}`);
    };
  }
  const asUser = (path, options = {}) => call(path, { ...options, headers: { authorization: "Bearer test-token" } });

  test("dashboard routes need a signed-in user", async () => {
    assert.equal((await call("/shipments")).status, 401);
    assert.equal((await call(`/shipments/${SHIPMENT_ID}`, { headers: DEVICE_HEADERS })).status, 401, "device keys do not work here");
  });

  test("the destination pharmacy's staff see the shipment, with derived status and numbers", async () => {
    userWorld({ role: "pharmacy_staff", pharmacyId: PH1 });
    const { status, body } = await asUser(`/shipments/${SHIPMENT_ID}`);
    assert.equal(status, 200);
    const s = body.shipment;
    assert.equal(s.shipmentNumber, "SH-000001");
    assert.deepEqual(s.destination.location, { name: "Colombo", latitude: 6.9271, longitude: 79.8612 });
    assert.equal(s.origin.name, "Central warehouse");
    assert.deepEqual(s.items[0], {
      id: "item-1",
      quantityShipped: 2,
      medicineId: "med-1",
      medicineName: "Insulin (soluble)",
      strength: "100 IU/mL",
      dosageForm: "injection",
      storageCondition: "refrigerated",
      batchNumber: "INS-001",
      expiryDate: "2027-06-30",
    });
    assert.deepEqual(s.limits, { storageCondition: "refrigerated", tempMinC: 2, tempMaxC: 8, humidityMinPct: null, humidityMaxPct: 85 });
    assert.equal(s.connection.status, "online");
    assert.equal(s.delivery.isOverdue, true);
    assert.equal(s.latestReading.temperatureC, 7.8);
    assert.deepEqual(s.openAlerts, { count: 2, highestLevel: "high" });
    assert.equal(s.latestPrediction, null);
    assert.equal(JSON.stringify(body).includes("key_hash"), false);
  });

  test("other pharmacies get 404; warehouse staff see every pharmacy's shipments", async () => {
    userWorld({ role: "pharmacy_staff", pharmacyId: PH2 });
    const other = await asUser(`/shipments/${SHIPMENT_ID}`);
    assert.deepEqual([other.status, other.body.error], [404, "Monitored shipment not found"]);
    userWorld({ role: "warehouse_staff" });
    assert.equal((await asUser(`/shipments/${SHIPMENT_ID}`)).status, 200);
  });

  test("pharmacy staff and plain users cannot change monitoring or manage devices", async () => {
    userWorld({ role: "pharmacy_staff", pharmacyId: PH1 });
    assert.equal((await asUser(`/shipments/${SHIPMENT_ID}`, { method: "PATCH", body: { tempMaxC: 7 } })).status, 403);
    assert.equal((await asUser("/devices", { method: "POST", body: { deviceCode: "ESP32-002" } })).status, 403);
    userWorld({ role: "warehouse_staff" });
    assert.equal((await asUser("/devices", { method: "POST", body: { deviceCode: "ESP32-002" } })).status, 403, "registering devices is for admins");
    userWorld({ role: "user" });
    assert.equal((await asUser(`/shipments/${SHIPMENT_ID}`)).status, 403);
  });

  test("invalid ids and unknown paths are answered as JSON", async () => {
    userWorld({ role: "admin" });
    const badId = await asUser("/shipments/SH-000001");
    assert.equal(badId.status, 400);
    assert.match(badId.body.details.fields.id, /valid id/);
    assert.equal((await asUser("/nope")).status, 404);
  });
});
