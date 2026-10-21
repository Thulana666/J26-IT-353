// Live end-to-end check of Component 2 against Supabase (after applying the
// cold-chain migrations): dispatched shipment -> driver/truck -> allocation ->
// start -> live sensor data -> risk prediction -> alerts -> delivery -> history.
//
//   * Device API: real HTTP requests to the running backend (BACKEND_URL,
//     default http://localhost:5000), with a temporary simulator device.
//   * Dashboard API: the real route code and database queries, run in this
//     process as an active admin. Only the user session is stubbed: a script
//     cannot sign in as a person.
//
// Everything runs on ONE shipment the warehouse already dispatched, as a TEST
// shipment with simulated readings, and with a temporary driver, truck and
// simulator (TEST-E2E-*, SIM-E2E-*). To replay an hour of readings, the test
// trip's start is moved 60 minutes back after it starts (test data only).
// By default everything it created is deleted at the end; --keep leaves the
// delivered trip and its fleet for viewing in the dashboard.
//
// Usage (from backend/, with the backend running):
//   node --env-file=.env scripts/check-cold-chain-api.js --shipment SH-000123 --driver-email a@x --other-driver-email b@y [--reset] [--keep]
//     --driver-email / --other-driver-email  two TEST accounts (plain users, created with Sign up) that are
//              linked to temporary drivers A and B; delivery can only be confirmed by driver A's account
//     --reset  first delete earlier TEST tracking of that shipment and unused TEST-E2E fleet
//     --keep   keep the delivered test trip, its readings and the TEST-E2E driver/truck/sensor
//     --cleanup  only delete what --keep left (same as --reset, without running the check)

const assert = require("node:assert/strict");
const express = require("express");
const supabase = require("../src/config/supabase");
const { errorHandler } = require("../src/cold-chain/errors");
const fleet = require("../src/cold-chain/routes/fleet");
const { BACKEND_URL } = require("./simulate-cold-chain");

const MIN = 60_000;
const DEFAULT_ROUTE = { from: { latitude: 6.9497, longitude: 79.922 }, to: { latitude: 6.9061, longitude: 79.8656 } };

function must({ data, error }) {
  if (error) throw new Error(`${error.code ?? ""} ${error.message}`.trim());
  return data;
}

// Dashboard routes in this process, signed in as a stub active admin.
async function startDashboardApi() {
  const app = express();
  app.use(express.json());
  // x-as: "admin" (default) or a driver account id; only the session is stubbed.
  app.use((req, _res, next) => {
    const as = req.get("x-as");
    req.user =
      as && as !== "admin"
        ? { id: as, email: "driver", role: "driver", pharmacyId: null, isActive: true, isAdmin: false, isPharmacyStaff: false, isWarehouseStaff: false }
        : { id: null, email: "check-script", role: "admin", pharmacyId: null, isActive: true, isAdmin: true, isPharmacyStaff: false, isWarehouseStaff: false };
    next();
  });
  app.use("/driver", require("../src/cold-chain/routes/driver"));
  app.use("/shipments", require("../src/cold-chain/routes/shipments"));
  app.use("/alerts", require("../src/cold-chain/routes/alerts"));
  app.use("/devices", require("../src/cold-chain/routes/devices"));
  app.use("/drivers", fleet.drivers);
  app.use("/trucks", fleet.trucks);
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

// Deletes earlier TEST tracking of the shipment and TEST-E2E fleet nobody uses.
async function reset(shipmentId) {
  const trip = must(await supabase.from("cold_chain_shipments").select("is_test, trip_status, driver_id, truck_id").eq("shipment_id", shipmentId).maybeSingle());
  if (trip && !trip.is_test) throw new Error("This shipment has real tracking; --reset only deletes test shipments.");
  if (trip && ["allocated", "in_transit"].includes(trip.trip_status) && (trip.driver_id || trip.truck_id)) {
    throw new Error("The test trip is live with a driver/truck: mark it delivered first (Cold Chain), then --reset.");
  }
  if (trip) must(await supabase.from("cold_chain_shipments").delete().eq("shipment_id", shipmentId).eq("is_test", true));
  // TEST-E2E drivers' portal accounts become plain users again.
  const linked = must(await supabase.from("cold_chain_drivers").select("profile_id").like("licence_number", "TEST-E2E-%").not("profile_id", "is", null));
  for (const { profile_id: profileId } of linked) {
    must(await supabase.from("profiles").update({ role: "user" }).eq("id", profileId).eq("role", "driver"));
  }
  for (const [table, column, pattern] of [
    ["cold_chain_trucks", "registration_number", "TEST-E2E-%"],
    ["cold_chain_drivers", "licence_number", "TEST-E2E-%"],
    ["cold_chain_devices", "device_code", "SIM-E2E-%"],
  ]) {
    const { error } = await supabase.from(table).delete().like(column, pattern);
    if (error) console.log(`      (kept some ${table}: still used by another trip)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shipmentNumber = args.includes("--shipment") ? args[args.indexOf("--shipment") + 1] : null;
  const keep = args.includes("--keep");
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const driverEmail = arg("--driver-email");
  const otherDriverEmail = arg("--other-driver-email");
  if (!shipmentNumber) throw new Error("Pass --shipment SH-xxxxxx: a shipment the warehouse dispatched (in transit).");
  const runStarted = new Date().toISOString();

  const shipment = must(
    await supabase
      .from("shipments")
      .select("id, shipment_number, status, pharmacy_id, pharmacy:pharmacies(name, location:locations(latitude, longitude)), warehouse:warehouses(location:locations(latitude, longitude))")
      .eq("shipment_number", shipmentNumber)
      .maybeSingle()
  );
  if (!shipment) throw new Error(`${shipmentNumber} not found`);
  if (args.includes("--cleanup")) {
    await reset(shipment.id);
    console.log(`Deleted the TEST tracking of ${shipmentNumber} and unused TEST-E2E drivers, trucks and sensors.`);
    return;
  }
  if (shipment.status !== "in_transit") throw new Error(`${shipmentNumber} is ${shipment.status}; choose a dispatched shipment that is in transit.`);
  if (args.includes("--reset")) await reset(shipment.id);
  if (!driverEmail || !otherDriverEmail) throw new Error("Pass --driver-email and --other-driver-email: two TEST accounts (plain users) for drivers A and B.");
  const tracked = must(await supabase.from("cold_chain_shipments").select("is_test").eq("shipment_id", shipment.id).maybeSingle());
  if (tracked) throw new Error(`${shipmentNumber} is already tracked${tracked.is_test ? " as a test shipment: pass --reset" : " for real; choose another shipment"}.`);

  const point = (l) => (l?.latitude != null ? { latitude: Number(l.latitude), longitude: Number(l.longitude) } : null);
  const route = point(shipment.warehouse?.location) && point(shipment.pharmacy?.location)
    ? { from: point(shipment.warehouse.location), to: point(shipment.pharmacy.location) }
    : DEFAULT_ROUTE;
  console.log(`End-to-end check on ${shipmentNumber} (${shipment.pharmacy?.name}); backend ${BACKEND_URL}\n`);

  const dashboard = await startDashboardApi();
  const api = (path, options = {}) => request(`${dashboard.url}${path}`, { ...options, headers: { ...(options.headers ?? {}), "x-as": options.as ?? "admin" } });
  const accounts = { a: null, b: null };
  const tag = Date.now().toString(36).toUpperCase().slice(-5);
  const now = Date.now();
  const t = (minutesAgo) => new Date(now - minutesAgo * MIN).toISOString();
  const along = (p) => ({
    latitude: Number((route.from.latitude + (route.to.latitude - route.from.latitude) * p).toFixed(6)),
    longitude: Number((route.from.longitude + (route.to.longitude - route.from.longitude) * p).toFixed(6)),
  });
  const ids = { driver: null, driverB: null, truck: null, device: null };
  let deviceCode = null;
  let deviceKey = null;
  const send = (body, headers) =>
    request(`${BACKEND_URL}/api/cold-chain/readings`, { method: "POST", body, headers: headers ?? { "x-device-id": deviceCode, "x-device-key": deviceKey } });
  const getShipment = () => api(`/shipments/${shipment.id}`).then((r) => r.body.shipment);
  const alerts = () => api(`/shipments/${shipment.id}/alerts`).then((r) => r.body.alerts);
  let sent = 0;

  try {
    await check("backend is running (GET /api/health)", async () => {
      assert.equal((await request(`${BACKEND_URL}/api/health`)).status, 200);
    });

    await check("1. add a driver (available)", async () => {
      const { status, body } = await api("/drivers", {
        method: "POST",
        body: { fullName: `TEST Driver ${tag}`, phone: "+94 77 000 0000", licenceNumber: `TEST-E2E-${tag}`, licenceExpiry: "2030-12-31" },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.driver.status, "available");
      ids.driver = body.driver.id;
    });

    await check("   link the drivers' portal accounts (driver A, and driver B for the access checks)", async () => {
      const b = await api("/drivers", {
        method: "POST",
        body: { fullName: `TEST Driver B ${tag}`, phone: "+94 77 000 0001", licenceNumber: `TEST-E2E-B${tag}`, licenceExpiry: "2030-12-31" },
      });
      assert.equal(b.status, 201, JSON.stringify(b.body));
      ids.driverB = b.body.driver.id;
      for (const [driverId, email, key] of [[ids.driver, driverEmail, "a"], [ids.driverB, otherDriverEmail, "b"]]) {
        const linked = await api(`/drivers/${driverId}/account`, { method: "POST", body: { email } });
        assert.equal(linked.status, 200, JSON.stringify(linked.body));
        assert.equal(linked.body.driver.account.email.toLowerCase(), email.toLowerCase());
        const profile = must(await supabase.from("profiles").select("id, role").ilike("email", email).single());
        assert.equal(profile.role, "driver");
        accounts[key] = profile.id;
      }
    });

    await check("2. add a refrigerated truck with an installed (simulator) sensor", async () => {
      const device = await api("/devices", { method: "POST", body: { deviceCode: `SIM-E2E-${tag}`, deviceType: "simulator", name: "E2E check (temporary)" } });
      assert.equal(device.status, 201, JSON.stringify(device.body));
      ({ deviceKey } = device.body);
      deviceCode = device.body.device.deviceCode;
      ids.device = device.body.device.id;
      const { status, body } = await api("/trucks", {
        method: "POST",
        body: { registrationNumber: `TEST-E2E-${tag}`, truckType: "refrigerated_truck", isRefrigerated: true, minTempC: -20, maxTempC: 20, deviceId: ids.device },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.deepEqual([body.truck.status, body.truck.isRefrigerated, body.truck.device.deviceCode], ["available", true, deviceCode]);
      ids.truck = body.truck.id;
    });

    await check("3. the dispatched order is offered for tracking", async () => {
      const { body } = await api("/shipments/available");
      assert.ok(body.shipments.some((s) => s.shipmentId === shipment.id), `${shipmentNumber} not offered`);
    });

    await check("4. create the shipment (test data, 2-8 °C, expected in 90 min): ready for dispatch", async () => {
      const { status, body } = await api("/shipments", {
        method: "POST",
        body: { shipmentId: shipment.id, isTest: true, tempMinC: 2, tempMaxC: 8, humidityMaxPct: 85, expectedDeliveryAt: t(-90) },
      });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.shipment.trip.status, "ready_for_dispatch");
      assert.equal(body.shipment.isTest, true);
    });

    await check("   readings before the trip starts are refused (409)", async () => {
      // The sensor is not allocated yet, then not started: both are refused.
      const before = await send({ shipmentNumber, readings: [{ recordedAt: new Date().toISOString(), temperatureC: 5 }] });
      assert.equal(before.status, 409, JSON.stringify(before.body));
    });

    await check("5-6. allocate driver and truck: the truck's sensor is assigned, both become assigned", async () => {
      const { status, body } = await api(`/shipments/${shipment.id}/allocate`, { method: "POST", body: { driverId: ids.driver, truckId: ids.truck } });
      assert.equal(status, 200, JSON.stringify(body));
      const s = body.shipment;
      assert.equal(s.trip.status, "allocated");
      assert.deepEqual([s.driver.status, s.truck.status, s.device.deviceCode], ["assigned", "assigned", deviceCode]);
      const again = await api(`/shipments/${shipment.id}/allocate`, { method: "POST", body: { driverId: ids.driver, truckId: "00000000-0000-4000-8000-000000000000" } });
      assert.deepEqual([again.status, again.body.error], [404, "Truck not found"]);
      const early = await send({ recordedAt: new Date().toISOString(), temperatureC: 5 });
      assert.deepEqual([early.status, early.body.error], [409, `The trip of shipment ${shipmentNumber} has not started yet`]);
    });

    await check("7-8. start the shipment: in transit, driver on trip, truck in use", async () => {
      const { status, body } = await api(`/shipments/${shipment.id}/start`, { method: "POST" });
      assert.equal(status, 200, JSON.stringify(body));
      const s = body.shipment;
      assert.equal(s.trip.status, "in_transit");
      assert.ok(s.trip.startedAt);
      assert.deepEqual([s.driver.status, s.truck.status], ["on_trip", "in_use"]);
      // Test data only: move the start an hour back so an hour of readings can be replayed.
      must(
        await supabase
          .from("cold_chain_shipments")
          .update({ trip_started_at: t(60), started_at: t(60) })
          .eq("shipment_id", shipment.id)
          .eq("is_test", true)
      );
    });

    await check("   device API rejects wrong keys (401) and invalid readings (400)", async () => {
      assert.equal((await send({ recordedAt: t(50), temperatureC: 5 }, { "x-device-id": deviceCode, "x-device-key": "ccd_wrong" })).status, 401);
      const bad = await send({ readings: [{ recordedAt: t(50), temperatureC: 200 }, { recordedAt: "yesterday", temperatureC: 5 }, { recordedAt: t(50), latitude: 95, longitude: 0 }] });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.details.rejected.length, 3);
    });

    await check("9-10. send 30 min of normal readings: stored in Supabase as simulator data", async () => {
      const readings = Array.from({ length: 30 }, (_, i) => ({ recordedAt: t(55 - i), temperatureC: 5 + (i % 3) * 0.1, humidityPct: 60, ...along(i / 60), speedKmh: 35 }));
      const { status, body } = await send({ shipmentNumber, readings });
      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.accepted, 30);
      assert.equal(body.risk.isPrototype, true);
      sent += 30;
      const { count } = await supabase.from("cold_chain_readings").select("id", { count: "exact", head: true }).eq("shipment_id", shipment.id).eq("source", "simulator");
      assert.equal(count, 30);
    });

    await check("11-13. the dashboard API shows live conditions, GPS and the chart series", async () => {
      const s = await getShipment();
      assert.equal(s.latestReading.recordedAt.slice(0, 16), t(26).slice(0, 16));
      assert.ok(s.latestReading.latitude && s.latestReading.longitude);
      assert.ok(["online", "delayed", "offline"].includes(s.connection.status));
      assert.deepEqual([s.orderNumber !== null, s.driver.fullName, s.truck.registrationNumber], [true, `TEST Driver ${tag}`, `TEST-E2E-${tag}`]);
      const series = await api(`/shipments/${shipment.id}/readings`);
      assert.equal(series.body.readings.length, 30);
    });

    await check("14-16. a rising temperature trend raises a predicted alert (prototype, with probability)", async () => {
      // 24 readings rising 0.11 °C/min: about 7.5 °C at the end, heading for the 8 °C limit.
      const readings = Array.from({ length: 24 }, (_, i) => ({ recordedAt: t(25 - i), temperatureC: Number((5 + i * 0.11).toFixed(2)), humidityPct: 61, ...along((30 + i) / 60), speedKmh: 33 }));
      const { body } = await send({ shipmentNumber, readings });
      assert.equal(body.accepted, 24);
      sent += 24;
      const risk = await api(`/shipments/${shipment.id}/risk`).then((r) => r.body.prediction);
      assert.equal(risk.isPrototype, true);
      assert.equal(risk.modelName, "prototype_rules");
      assert.ok(risk.factors.temperature_excursion.probability >= 0.6, JSON.stringify(risk.factors.temperature_excursion));
      assert.match(risk.factors.temperature_excursion.explanation, /rising about .* may cross the 8 °C limit/);
      const predicted = (await alerts()).find((a) => a.basis === "predicted" && a.riskType === "temperature_excursion" && a.status !== "resolved");
      assert.ok(predicted, "predicted temperature alert");
      assert.ok(predicted.riskProbability >= 0.6);
      assert.match(predicted.message, /prototype rule-based predictor/);
    });

    await check("15-16. a measured excursion raises an observed alert and replaces the prediction", async () => {
      const { body } = await send({ recordedAt: t(1), temperatureC: 9.2, humidityPct: 62, ...along(55 / 60), speedKmh: 30 });
      assert.equal(body.accepted, 1);
      sent += 1;
      const list = await alerts();
      const observed = list.find((a) => a.basis === "observed" && a.riskType === "temperature_excursion" && a.status !== "resolved");
      assert.ok(observed && observed.riskLevel === "high", JSON.stringify(list.map((a) => [a.basis, a.riskType, a.status])));
      assert.match(observed.message, /Measured temperature reached 9\.2 °C, above the 8 °C limit/);
      const predicted = list.find((a) => a.basis === "predicted" && a.riskType === "temperature_excursion");
      assert.equal(predicted.status, "resolved", "the measurement supersedes the prediction");
    });

    await check("   a passed expected delivery time raises a 'possible delivery delay' alert", async () => {
      const patch = await api(`/shipments/${shipment.id}`, { method: "PATCH", body: { expectedDeliveryAt: t(10) } });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      const { body } = await send({ recordedAt: new Date(now - 30_000).toISOString(), temperatureC: 7.1, humidityPct: 62, ...along(56 / 60), speedKmh: 30 });
      assert.equal(body.accepted, 1);
      sent += 1;
      const delay = (await alerts()).find((a) => a.basis === "predicted" && a.riskType === "delivery_delay" && a.status !== "resolved");
      assert.ok(delay, "delivery delay alert");
      assert.equal(delay.title, "Possible delivery delay");
    });

    await check("Driver A sees only their own deliveries; driver B sees none of them", async () => {
      const a = await api("/driver/deliveries", { as: accounts.a });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      assert.deepEqual(a.body.active.map((x) => x.shipmentNumber), [shipmentNumber]);
      const b = await api("/driver/deliveries", { as: accounts.b });
      assert.equal(b.status, 200);
      assert.equal([...b.body.active, ...b.body.upcoming, ...b.body.recent].length, 0);
      const peek = await api(`/driver/deliveries/${shipment.id}`, { as: accounts.b });
      assert.equal(peek.status, 404);
    });

    await check("Driver A opens the delivery and reports an issue; it is stored with the sensor snapshot", async () => {
      const detail = await api(`/driver/deliveries/${shipment.id}`, { as: accounts.a });
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.equal(detail.body.delivery.status, "in_transit");
      assert.ok(detail.body.delivery.latestReading && detail.body.delivery.truck.registrationNumber);
      const issue = await api(`/driver/deliveries/${shipment.id}/issues`, { as: accounts.a, method: "POST", body: { issueType: "temperature", description: "E2E check: reefer alarm" } });
      assert.equal(issue.status, 201, JSON.stringify(issue.body));
      const row = must(await supabase.from("cold_chain_issues").select("*").eq("id", issue.body.issue.id).single());
      assert.deepEqual([row.driver_id, row.reported_by, row.issue_type, row.status], [ids.driver, accounts.a, "temperature", "open"]);
      assert.ok(row.reading_at && row.temperature_c !== null, "sensor snapshot attached");
      const staffView = await api(`/shipments/${shipment.id}/issues`);
      assert.equal(staffView.body.issues.length, 1);
    });

    await check("warehouse/admin and driver B cannot confirm the delivery", async () => {
      const staff = await api(`/shipments/${shipment.id}/deliver`, { method: "POST", body: {} });
      assert.deepEqual([staff.status, staff.body.error], [403, "Only the assigned driver can confirm delivery, in the Driver Portal"]);
      const adminPortal = await api(`/driver/deliveries/${shipment.id}/deliver`, { method: "POST", body: {} });
      assert.equal(adminPortal.status, 403);
      const other = await api(`/driver/deliveries/${shipment.id}/deliver`, { as: accounts.b, method: "POST", body: {} });
      assert.equal(other.status, 404);
      const rpc = await supabase.rpc("cold_chain_deliver_trip", { p_shipment_id: shipment.id, p_user_id: accounts.b });
      assert.match(rpc.error?.message ?? "", /Only the driver assigned/, "the database refuses it too");
      assert.equal((await getShipment()).trip.status, "in_transit");
    });

    await check("17-19. driver A confirms delivery: delivery time and final readings recorded", async () => {
      const { status, body } = await api(`/driver/deliveries/${shipment.id}/deliver`, { as: accounts.a, method: "POST", body: { notes: "E2E check: handed over" } });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.result.status, "delivered");
      assert.equal(body.result.final.temperatureC, 7.1);
      const s = await getShipment();
      assert.equal(s.trip.status, "delivered");
      assert.ok(s.trip.deliveredAt);
      assert.ok(s.trip.final.latitude && s.trip.final.longitude);
      assert.equal(s.trip.deliveryNotes, "E2E check: handed over");
      assert.equal(s.driver.fullName, `TEST Driver ${tag}`, "the warehouse sees who delivered it");
      const row = must(await supabase.from("cold_chain_shipments").select("delivered_by").eq("shipment_id", shipment.id).single());
      assert.equal(row.delivered_by, accounts.a);
      assert.equal(s.monitoringStatus, "ended");
      const openPredicted = (await alerts()).filter((a) => a.basis === "predicted" && a.status !== "resolved");
      assert.deepEqual(openPredicted, [], "predicted alerts are closed with the trip");
    });

    await check("20-21. the driver and the truck are available again", async () => {
      const drivers = await api("/drivers").then((r) => r.body.drivers);
      const trucks = await api("/trucks").then((r) => r.body.trucks);
      assert.equal(drivers.find((d) => d.id === ids.driver).status, "available");
      assert.equal(trucks.find((x) => x.id === ids.truck).status, "available");
    });

    await check("22. the shipment is in the history with its summaries", async () => {
      const { body } = await api("/shipments?tripStatus=delivered");
      const s = body.shipments.find((x) => x.shipmentId === shipment.id);
      assert.ok(s, "in history");
      assert.equal(s.summary.readings, sent);
      assert.ok(s.summary.temperature.outside >= 1);
      assert.ok(s.summary.alerts >= 3, `alerts ${s.summary.alerts}`);
      assert.ok(s.summary.maxRiskProbability >= 0.6);
      assert.ok(s.trip.durationMinutes >= 59);
    });

    await check("23. sensor history remains; buffered readings before delivery are accepted, later ones refused", async () => {
      const series = await api(`/shipments/${shipment.id}/readings`);
      assert.equal(series.body.readings.length, sent);
      const buffered = await send({ shipmentNumber, readings: [{ recordedAt: new Date(now - 10_000).toISOString(), temperatureC: 7.0 }] });
      assert.equal(buffered.status, 201, JSON.stringify(buffered.body));
      sent += 1;
      const late = await send({ shipmentNumber, readings: [{ recordedAt: new Date(Date.now() + 60_000).toISOString(), temperatureC: 7.0 }] });
      assert.equal(late.status, 400);
    });
  } finally {
    dashboard.server.close();
    if (keep) {
      console.log(`\nKept for viewing: ${shipmentNumber} (delivered test trip), TEST Driver ${tag} (account ${driverEmail}), TEST Driver B ${tag} (${otherDriverEmail}), truck TEST-E2E-${tag}, sensor SIM-E2E-${tag}.`);
      console.log(`Remove later: node --env-file=.env scripts/check-cold-chain-api.js --shipment ${shipmentNumber} --cleanup`);
    } else {
      must(await supabase.from("cold_chain_shipments").delete().eq("shipment_id", shipment.id).eq("is_test", true));
      if (ids.truck) must(await supabase.from("cold_chain_trucks").delete().eq("id", ids.truck));
      for (const profileId of [accounts.a, accounts.b].filter(Boolean)) {
        must(await supabase.from("profiles").update({ role: "user" }).eq("id", profileId).eq("role", "driver"));
      }
      for (const driverId of [ids.driver, ids.driverB].filter(Boolean)) must(await supabase.from("cold_chain_drivers").delete().eq("id", driverId));
      if (ids.device) must(await supabase.from("cold_chain_devices").delete().eq("id", ids.device));
      const entityIds = [shipment.id, ids.driver, ids.driverB, ids.truck, ids.device].filter(Boolean);
      must(await supabase.from("audit_logs").delete().eq("module", "cold_chain").in("entity_id", entityIds).gte("created_at", runStarted));
      console.log("\nCleaned up: test trip with its readings, alerts and predictions; temporary driver, truck and sensor; audit entries.");
    }
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`Check stopped: ${error.message}`);
  process.exitCode = 1;
});
