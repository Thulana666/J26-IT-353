// Live checks of the Component 2 API against Supabase (after applying
// supabase/migrations/20261017000000_create_cold_chain_schema.sql).
//
//   * Device API: real HTTP requests to the running backend (BACKEND_URL,
//     default http://localhost:5000) with a temporary simulator device.
//   * Dashboard API: the real route code and database queries, run in this
//     process as an active admin. Only the user session is stubbed: a script
//     cannot sign in as a person (the backend verifies Supabase sessions for
//     every other module the same way).
//
// Everything it creates is TEST data on one in-transit SAMPLE shipment, and is
// deleted at the end: the temporary device, the shipment's test monitoring
// with its readings and alerts, and the audit entries of this run.
//
// Usage (from backend/, with the backend running):
//   node --env-file=.env scripts/check-cold-chain-api.js [--shipment SH-000123] [--reset]
//     --reset   first delete existing TEST monitoring of that shipment (e.g. simulator data)

const assert = require("node:assert/strict");
const express = require("express");
const supabase = require("../src/config/supabase");
const { errorHandler } = require("../src/cold-chain/errors");
const { findShipment, routeOf, BACKEND_URL } = require("./simulate-cold-chain");

const MIN = 60_000;

function must({ data, error }) {
  if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
  return data;
}

// Dashboard routes in this process, signed in as a stub active admin.
async function startDashboardApi() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: null, email: "check-script", role: "admin", pharmacyId: null, isActive: true, isAdmin: true, isPharmacyStaff: false, isWarehouseStaff: false };
    next();
  });
  app.use("/shipments", require("../src/cold-chain/routes/shipments"));
  app.use("/alerts", require("../src/cold-chain/routes/alerts"));
  app.use("/devices", require("../src/cold-chain/routes/devices"));
  app.use(errorHandler);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function request(url, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shipmentArg = args.includes("--shipment") ? args[args.indexOf("--shipment") + 1] : null;
  const runStarted = new Date().toISOString();

  const shipment = await findShipment(shipmentArg);
  const existing = must(await supabase.from("cold_chain_shipments").select("is_test").eq("shipment_id", shipment.id).maybeSingle());
  if (existing && !existing.is_test) throw new Error(`${shipment.shipment_number} has real monitoring; choose another shipment.`);
  if (existing && !args.includes("--reset")) {
    throw new Error(`${shipment.shipment_number} already has TEST monitoring. Pass --reset to delete it (and its test readings) first.`);
  }
  if (existing) must(await supabase.from("cold_chain_shipments").delete().eq("shipment_id", shipment.id).eq("is_test", true));
  console.log(`Checking against ${shipment.shipment_number} (${shipment.pharmacy.name}); backend ${BACKEND_URL}\n`);

  const dashboard = await startDashboardApi();
  const api = (path, options) => request(`${dashboard.url}${path}`, options);
  const route = routeOf(shipment);
  const now = Date.now();
  const t = (minutesAgo) => new Date(now - minutesAgo * MIN).toISOString();
  let device = null;
  let deviceKey = null;
  const send = (body, headers) =>
    request(`${BACKEND_URL}/api/cold-chain/readings`, {
      method: "POST",
      body,
      headers: headers ?? { "x-device-id": device.deviceCode, "x-device-key": deviceKey },
    });
  const storedReading = (minutesAgo) =>
    supabase.from("cold_chain_readings").select("*").eq("shipment_id", shipment.id).eq("recorded_at", t(minutesAgo)).single().then(must);
  const activeAlerts = () =>
    supabase.from("cold_chain_alerts").select("*").eq("shipment_id", shipment.id).neq("status", "resolved").then(must);
  let alertId = null;

  try {
    await check("backend is running (GET /api/health)", async () => {
      const { status } = await request(`${BACKEND_URL}/api/health`);
      assert.equal(status, 200);
    });

    await check("register a simulator device: the key is returned once and never stored in plain text", async () => {
      const { status, body } = await api("/devices", {
        method: "POST",
        body: { deviceCode: `CHK-${now.toString(36).toUpperCase()}`, deviceType: "simulator", name: "API check (temporary)" },
      });
      assert.equal(status, 201, JSON.stringify(body));
      ({ device, deviceKey } = body);
      assert.match(deviceKey, /^ccd_/);
      const row = must(await supabase.from("cold_chain_devices").select("key_hash").eq("id", device.id).single());
      assert.match(row.key_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.key_hash, deviceKey);
    });

    // Explicit 2-8 °C limits, so the checks below do not depend on the items' storage condition.
    await check("start TEST monitoring through the API with explicit limits", async () => {
      const { status, body } = await api("/shipments", {
        method: "POST",
        body: {
          shipmentId: shipment.id,
          deviceId: device.id,
          isTest: true,
          startedAt: t(60),
          expectedDeliveryAt: t(-120),
          tempMinC: 2,
          tempMaxC: 8,
          humidityMaxPct: 85,
        },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.shipment.shipmentNumber, shipment.shipment_number);
      assert.equal(body.shipment.isTest, true);
      assert.deepEqual(
        [body.shipment.limits.tempMinC, body.shipment.limits.tempMaxC, body.shipment.limits.humidityMaxPct],
        [2, 8, 85]
      );
      assert.equal(body.shipment.device.deviceCode, device.deviceCode);
    });

    await check("device API refuses missing and wrong keys (401)", async () => {
      const reading = { recordedAt: t(50), temperatureC: 5 };
      assert.equal((await send(reading, {})).status, 401);
      assert.equal((await send(reading, { "x-device-id": device.deviceCode, "x-device-key": "ccd_wrong" })).status, 401);
    });

    await check("a reading is stored (201) as simulator data with server time and flags", async () => {
      const { status, body } = await send({ recordedAt: t(50), temperatureC: 5.0, humidityPct: 60, ...route.from, speedKmh: 30 });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.accepted, 1);
      const row = await storedReading(50);
      assert.equal(row.source, "simulator");
      assert.equal(Number(row.temperature_c), 5);
      assert.ok(Date.parse(row.received_at) > Date.parse(row.recorded_at));
      assert.deepEqual(row.quality_flags, ["delayed_upload"], "recorded 50 minutes before upload");
    });

    await check("a resent reading is a duplicate (200), stored once", async () => {
      const { status, body } = await send({ recordedAt: t(50), temperatureC: 6.0 });
      assert.equal(status, 200, JSON.stringify(body));
      assert.deepEqual([body.accepted, body.duplicates], [0, [t(50)]]);
      assert.equal(Number((await storedReading(50)).temperature_c), 5, "the first value is kept");
    });

    await check("a batch by shipment number keeps valid readings and reports the rest", async () => {
      const { status, body } = await send({
        shipmentNumber: shipment.shipment_number,
        readings: [
          { recordedAt: t(48), temperatureC: 5.1 },
          { recordedAt: t(47), temperatureC: "5.2" },
          { recordedAt: t(48), temperatureC: 5.1 },
          { recordedAt: t(90), temperatureC: 5.0 },
        ],
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.accepted, 1);
      assert.deepEqual(body.duplicates, [t(48)]);
      assert.deepEqual(body.rejected.map((r) => r.index), [1, 3]);
      assert.match(body.rejected[1].errors.recordedAt, /before monitoring/);
    });

    await check("an implausible GPS move is stored unchanged with a gps_jump flag", async () => {
      const far = { latitude: route.from.latitude + 1, longitude: route.from.longitude };
      const { status } = await send({ readings: [{ recordedAt: t(46), temperatureC: 5, ...route.from }, { recordedAt: t(45), temperatureC: 5, ...far }] });
      assert.equal(status, 201);
      const row = await storedReading(45);
      assert.ok(row.quality_flags.includes("gps_jump"), JSON.stringify(row.quality_flags));
      assert.equal(Number(row.latitude), far.latitude);
    });

    await check("a temperature above the limit opens one observed alert", async () => {
      const { body } = await send({ recordedAt: t(44), temperatureC: 9.5 });
      assert.deepEqual(body.alerts, { opened: 1, updated: 0, resolved: 0 });
      const [alert] = await activeAlerts();
      assert.equal(alert.dedupe_key, "temperature_excursion:above");
      assert.deepEqual([alert.risk_level, alert.basis, alert.status, alert.occurrences], ["high", "observed", "open", 1]);
      alertId = alert.id;
    });

    await check("staff can acknowledge the alert; repeating it changes nothing", async () => {
      const first = await api(`/alerts/${alertId}/acknowledge`, { method: "POST" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.alert.status, "acknowledged");
      const again = await api(`/alerts/${alertId}/acknowledge`, { method: "POST" });
      assert.equal(again.body.alert.acknowledgedAt, first.body.alert.acknowledgedAt);
    });

    await check("a continuing excursion updates that alert instead of adding another", async () => {
      const { body } = await send({ recordedAt: t(43), temperatureC: 9.8 });
      assert.deepEqual(body.alerts, { opened: 0, updated: 1, resolved: 0 });
      const alerts = await activeAlerts();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].occurrences, 2);
      assert.equal(alerts[0].details.peakValue, 9.8);
      assert.equal(alerts[0].status, "acknowledged", "same level: stays acknowledged");
    });

    await check("the alert resolves when the temperature is back in range", async () => {
      const { body } = await send({ recordedAt: t(42), temperatureC: 5.0 });
      assert.deepEqual(body.alerts, { opened: 0, updated: 0, resolved: 1 });
      const alert = must(await supabase.from("cold_chain_alerts").select("status, resolved_at").eq("id", alertId).single());
      assert.equal(alert.status, "resolved");
      assert.ok(alert.resolved_at);
    });

    await check("the database trigger and the API refuse simulator data for a non-test shipment", async () => {
      must(await supabase.from("cold_chain_shipments").update({ is_test: false }).eq("shipment_id", shipment.id));
      try {
        const { status, body } = await send({ recordedAt: t(41), temperatureC: 5 });
        assert.deepEqual([status, body.error], [409, "A simulator can only report for test shipments"]);
        const { error } = await supabase
          .from("cold_chain_readings")
          .insert({ shipment_id: shipment.id, pharmacy_id: shipment.pharmacy_id, source: "simulator", recorded_at: t(41), temperature_c: 5 });
        assert.match(error?.message ?? "", /Simulated readings can only be stored for test shipments/);
      } finally {
        must(await supabase.from("cold_chain_shipments").update({ is_test: true }).eq("shipment_id", shipment.id));
      }
    });

    await check("a deactivated device is refused (403) until it is reactivated", async () => {
      assert.equal((await api(`/devices/${device.id}`, { method: "PATCH", body: { isActive: false } })).status, 200);
      assert.equal((await send({ recordedAt: t(40), temperatureC: 5 })).status, 403);
      assert.equal((await api(`/devices/${device.id}`, { method: "PATCH", body: { isActive: true } })).status, 200);
      assert.equal((await send({ recordedAt: t(40), temperatureC: 5 })).status, 201);
    });

    await check("a current reading is stored without data-quality flags", async () => {
      const recordedAt = new Date().toISOString();
      const { status } = await send({ recordedAt, temperatureC: 5.4, humidityPct: 61, ...route.to, speedKmh: 0 });
      assert.equal(status, 201);
      const row = must(await supabase.from("cold_chain_readings").select("quality_flags").eq("shipment_id", shipment.id).eq("recorded_at", recordedAt).single());
      assert.deepEqual(row.quality_flags, []);
    });

    await check("dashboard routes on the running backend need a user session (401)", async () => {
      assert.equal((await request(`${BACKEND_URL}/api/cold-chain/shipments`)).status, 401);
    });

    await check("GET /shipments lists the shipment with its newest reading, connection and alerts", async () => {
      const { status, body } = await api("/shipments?test=true&status=active");
      assert.equal(status, 200, JSON.stringify(body));
      const item = body.shipments.find((s) => s.shipmentId === shipment.id);
      assert.ok(item, "test shipment listed");
      assert.equal(item.latestReading.temperatureC, 5.4);
      assert.equal(item.connection.status, "online");
      assert.deepEqual(item.openAlerts, { count: 0, highestLevel: null });
      assert.equal(item.latestPrediction, null);
    });

    await check("GET /shipments/:id returns route, items, limits and delivery", async () => {
      const { status, body } = await api(`/shipments/${shipment.id}`);
      assert.equal(status, 200, JSON.stringify(body));
      const s = body.shipment;
      assert.ok(s.origin?.name && s.destination?.name);
      assert.ok(s.items.length > 0 && s.items[0].medicineName && s.items[0].batchNumber);
      assert.equal(s.delivery.status, "in_transit");
      assert.equal(s.delivery.isOverdue, false);
      assert.equal(s.isTest, true);
    });

    await check("GET /shipments/:id/readings returns the newest readings oldest first, and time ranges", async () => {
      const latest = await api(`/shipments/${shipment.id}/readings?limit=3`);
      assert.equal(latest.status, 200, JSON.stringify(latest.body));
      const times = latest.body.readings.map((r) => Date.parse(r.recordedAt));
      assert.equal(times.length, 3);
      assert.ok(times[0] < times[1] && times[1] < times[2]);
      assert.equal(latest.body.truncated, true);
      const range = await api(`/shipments/${shipment.id}/readings?from=${encodeURIComponent(t(48))}&to=${encodeURIComponent(t(44))}`);
      assert.deepEqual(range.body.readings.map((r) => r.recordedAt).map((v) => new Date(v).toISOString()), [t(48), t(46), t(45), t(44)]);
    });

    await check("GET /shipments/:id/alerts filters by status; GET /risk has no prediction yet", async () => {
      const resolved = await api(`/shipments/${shipment.id}/alerts?status=resolved`);
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      assert.equal(resolved.body.alerts.length, 1);
      assert.match(resolved.body.alerts[0].title, /Temperature above the safe range/);
      assert.equal((await api(`/shipments/${shipment.id}/alerts?status=closed`)).status, 400);
      const risk = await api(`/shipments/${shipment.id}/risk`);
      assert.deepEqual([risk.status, risk.body.prediction], [200, null]);
    });

    await check("GET /shipments/available and GET /devices", async () => {
      const available = await api("/shipments/available");
      assert.equal(available.status, 200, JSON.stringify(available.body));
      assert.ok(!available.body.shipments.some((s) => s.shipmentId === shipment.id), "monitored shipments are not offered");
      const devices = await api("/devices");
      assert.equal(devices.status, 200);
      const mine = devices.body.devices.find((d) => d.id === device.id);
      assert.equal(mine.activeShipment?.shipmentNumber, shipment.shipment_number);
      assert.equal(JSON.stringify(devices.body).includes("key_hash"), false);
    });

    await check("PATCH /shipments/:id changes limits and rejects an invalid range", async () => {
      const ok = await api(`/shipments/${shipment.id}`, { method: "PATCH", body: { tempMaxC: 7.5 } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.shipment.limits.tempMaxC, 7.5);
      const bad = await api(`/shipments/${shipment.id}`, { method: "PATCH", body: { tempMinC: 9 } });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.details.fields.tempMaxC);
    });

    await check("after monitoring ends, buffered readings from before the end are accepted, later ones are not", async () => {
      const ended = await api(`/shipments/${shipment.id}`, { method: "PATCH", body: { monitoringStatus: "ended" } });
      assert.equal(ended.body.shipment.monitoringStatus, "ended");
      const unnamed = await send({ recordedAt: new Date().toISOString(), temperatureC: 5 });
      assert.deepEqual([unnamed.status, unnamed.body.error], [409, "This device is not assigned to an active shipment"]);
      const buffered = await send({ shipmentNumber: shipment.shipment_number, readings: [{ recordedAt: t(30), temperatureC: 5 }] });
      assert.equal(buffered.status, 201, JSON.stringify(buffered.body));
      const late = await send({ shipmentNumber: shipment.shipment_number, readings: [{ recordedAt: new Date(Date.now() + 30_000).toISOString(), temperatureC: 5 }] });
      assert.equal(late.status, 400);
      assert.match(late.body.details.rejected[0].errors.recordedAt, /after monitoring/);
    });
  } finally {
    dashboard.server.close();
    // Remove everything this run created.
    must(await supabase.from("cold_chain_shipments").delete().eq("shipment_id", shipment.id).eq("is_test", true));
    const ids = [shipment.id, ...(device ? [device.id] : [])];
    must(await supabase.from("audit_logs").delete().eq("module", "cold_chain").in("entity_id", ids).gte("created_at", runStarted));
    if (device) must(await supabase.from("cold_chain_devices").delete().eq("id", device.id));
    console.log("\nCleaned up: temporary device, test monitoring, its readings and alerts, and this run's audit entries.");
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`Check stopped: ${error.message}`);
  process.exitCode = 1;
});
