// Database tests for Component 2: runs every migration in supabase/migrations
// and the sample warehouse/pharmacy seeds in an in-memory PostgreSQL (PGlite),
// with minimal Supabase stubs, then checks the cold-chain triggers,
// constraints, views and row level security.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Same stubs as test/pharmacy/database.test.mjs.
const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
create publication supabase_realtime;
`;

let db;
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const rejects = (promise, pattern) => assert.rejects(promise, (e) => (assert.match(e.message, pattern), true));

async function makeUser(email, role, pharmacyCode = null) {
  const { id } = await one("insert into auth.users (email) values ($1) returning id", [email]);
  await db.query("update public.profiles set role = $2, pharmacy_id = (select id from public.pharmacies where code = $3) where id = $1", [id, role, pharmacyCode]);
  return id;
}

async function asUser(userId, fn) {
  await db.exec("set role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function dispatchOrder(pharmacy, staff, medicineName, quantity) {
  const medicine = (await one("select id from medicines where name = $1", [medicineName])).id;
  const order = await one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [pharmacy, staff, JSON.stringify([{ medicineId: medicine, quantity }])]);
  return one("select * from pharmacy_dispatch_order($1, $2)", [order.id, whStaff]);
}

const addDevice = (code, type = "esp32") =>
  one("insert into cold_chain_devices (device_code, device_type, key_hash) values ($1, $2, repeat('a', 64)) returning *", [code, type]);

// A monitored shipment whose trip is already running (as monitoring worked
// before the logistics workflow), unless `trip` says otherwise.
const monitor = (shipmentId, deviceId, { isTest = false, pharmacyId = null, trip = "in_transit" } = {}) =>
  one(
    `insert into cold_chain_shipments
       (shipment_id, pharmacy_id, device_id, storage_condition, temp_min_c, temp_max_c, humidity_max_pct, is_test, started_at,
        trip_status, trip_started_at)
     values ($1, coalesce($2, (select pharmacy_id from shipments where id = $1)), $3, 'refrigerated', 2, 8, 85, $4, now() - interval '1 day',
             $5, case when $5 = 'in_transit' then now() - interval '1 day' end)
     returning *`,
    [shipmentId, pharmacyId, deviceId, isTest, trip]
  );

const addReading = (shipmentId, { at = "now()", source = "device", temperature = 5, humidity = 60, lat = null, lng = null } = {}) =>
  db.query(
    `insert into cold_chain_readings (shipment_id, pharmacy_id, source, recorded_at, temperature_c, humidity_pct, latitude, longitude)
     values ($1, (select pharmacy_id from cold_chain_shipments where shipment_id = $1), $2, ${at}, $3, $4, $5, $6) returning *`,
    [shipmentId, source, temperature, humidity, lat, lng]
  ).then((r) => r.rows[0]);

const addAlert = (shipmentId, key, { basis = "observed", probability = null } = {}) =>
  one(
    `insert into cold_chain_alerts (shipment_id, pharmacy_id, risk_type, risk_level, basis, risk_probability, title, message, dedupe_key, first_detected_at, last_detected_at)
     values ($1, (select pharmacy_id from cold_chain_shipments where shipment_id = $1), 'temperature_excursion', 'high', $2, $3, 't', 'm', $4, now(), now())
     returning *`,
    [shipmentId, basis, probability, key]
  );

const addPrediction = (shipmentId, at) =>
  one(
    `insert into cold_chain_risk_predictions (shipment_id, pharmacy_id, model_name, model_version, is_prototype, risk_level, risk_probability, explanation, horizon_minutes, readings_used, predicted_at)
     values ($1, (select pharmacy_id from cold_chain_shipments where shipment_id = $1), 'prototype_rules', '0.1', true, 'low', 0.1, 'test', 60, 10, ${at})
     returning *`,
    [shipmentId]
  );

let COL, KDY, admin, colStaff, kdyStaff, whStaff, plainUser;
// shipCol: the seeded in-transit shipment (Colombo); shipCol2 / shipKdy: dispatched here.
let shipCol, shipCol2, shipKdy, esp1, esp2, sim;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const dir = path.join(ROOT, "supabase/migrations");
  for (const file of fs.readdirSync(dir).sort()) await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const file of ["sample_warehouse.sql", "sample_pharmacy.sql"]) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/seed", file), "utf8"));
  }
  COL = (await one("select id from pharmacies where code = 'SAMPLE-PH-COL'")).id;
  KDY = (await one("select id from pharmacies where code = 'SAMPLE-PH-KDY'")).id;
  admin = await makeUser("admin@test.local", "admin");
  colStaff = await makeUser("col@test.local", "pharmacy_staff", "SAMPLE-PH-COL");
  kdyStaff = await makeUser("kdy@test.local", "pharmacy_staff", "SAMPLE-PH-KDY");
  whStaff = await makeUser("wh@test.local", "warehouse_staff");
  plainUser = await makeUser("user@test.local", "user");

  shipCol = (await one("select id from shipments where status = 'in_transit' and pharmacy_id = $1", [COL])).id;
  shipCol2 = (await dispatchOrder(COL, colStaff, "Salbutamol", 1)).id;
  shipKdy = (await dispatchOrder(KDY, kdyStaff, "Metformin", 1)).id;

  esp1 = await addDevice("ESP32-001");
  esp2 = await addDevice("ESP32-002");
  sim = await addDevice("SIM-001", "simulator");
  await monitor(shipCol, esp1.id);
  await monitor(shipKdy, sim.id, { isTest: true });
});

after(() => db?.close());

describe("monitored shipments", () => {
  test("the migration created the cold-chain tables and published them for Realtime", async () => {
    const published = await all("select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename like 'cold_chain%' order by 1");
    assert.deepEqual(published.map((r) => r.tablename), ["cold_chain_alerts", "cold_chain_issues", "cold_chain_readings", "cold_chain_risk_predictions", "cold_chain_shipments"]);
  });

  test("a monitored shipment always takes its own shipment's pharmacy", async () => {
    const row = await monitor(shipCol2, null, { pharmacyId: KDY });
    assert.equal(row.pharmacy_id, COL);
    await db.query("delete from cold_chain_shipments where shipment_id = $1", [shipCol2]);
  });

  test("unknown shipments, invalid limits and an end without an end time are rejected", async () => {
    await rejects(monitor("00000000-0000-4000-8000-000000000000", null, { pharmacyId: COL }), /Shipment not found/);
    await rejects(db.query("update cold_chain_shipments set temp_min_c = 9 where shipment_id = $1", [shipCol]), /check constraint/);
    await rejects(db.query("update cold_chain_shipments set humidity_max_pct = 120 where shipment_id = $1", [shipCol]), /check constraint/);
    await rejects(db.query("update cold_chain_shipments set monitoring_status = 'ended' where shipment_id = $1", [shipCol]), /check constraint/);
    await rejects(db.query("insert into cold_chain_devices (device_code, key_hash) values ('bad code', repeat('a', 64))"), /check constraint/);
    await rejects(db.query("insert into cold_chain_devices (device_code, key_hash) values ('ESP32-009', 'plain-key')"), /check constraint/);
  });

  test("a device reports for one active shipment at a time; once that ends it can be reassigned", async () => {
    await rejects(db.query("update cold_chain_shipments set device_id = $1 where shipment_id = $2", [esp1.id, shipKdy]), /cold_chain_shipments_active_device/);
    await db.exec("begin");
    try {
      await db.query("update cold_chain_shipments set monitoring_status = 'ended', ended_at = now() where shipment_id = $1", [shipCol]);
      await db.query("update cold_chain_shipments set device_id = $1 where shipment_id = $2", [esp1.id, shipKdy]);
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("readings", () => {
  test("a reading takes the pharmacy of its monitored shipment", async () => {
    const row = await db
      .query("insert into cold_chain_readings (shipment_id, pharmacy_id, source, recorded_at, temperature_c) values ($1, $2, 'device', now() - interval '3 hours', 5) returning pharmacy_id", [shipCol, KDY])
      .then((r) => r.rows[0]);
    assert.equal(row.pharmacy_id, COL);
  });

  test("simulated readings are only stored for test shipments", async () => {
    await rejects(addReading(shipCol, { source: "simulator" }), /Simulated readings can only be stored for test shipments/);
    assert.equal((await addReading(shipKdy, { source: "simulator" })).source, "simulator");
  });

  test("readings need a monitored shipment", async () => {
    await rejects(
      db.query("insert into cold_chain_readings (shipment_id, pharmacy_id, source, recorded_at, temperature_c) values ($1, $2, 'device', now(), 5)", [shipCol2, COL]),
      /Shipment is not monitored/
    );
  });

  test("a resent reading (same shipment and time) is skipped with ON CONFLICT and refused otherwise", async () => {
    const at = "'2026-10-17T03:00:00Z'";
    await addReading(shipCol, { at });
    const skipped = await db.query(
      `insert into cold_chain_readings (shipment_id, pharmacy_id, source, recorded_at, temperature_c) values ($1, $2, 'device', ${at}, 6)
       on conflict (shipment_id, recorded_at) do nothing returning id`,
      [shipCol, COL]
    );
    assert.equal(skipped.rows.length, 0);
    assert.equal(Number((await one(`select temperature_c from cold_chain_readings where shipment_id = $1 and recorded_at = ${at}`, [shipCol])).temperature_c), 5, "the first value is kept");
    await rejects(addReading(shipCol, { at }), /duplicate key/);
  });

  test("impossible values are refused by the database as a last line of defence", async () => {
    let minute = 0;
    const at = () => `now() - interval '${++minute} minutes' - interval '1 day' + interval '2 hours'`;
    await rejects(addReading(shipCol, { at: at(), temperature: 90 }), /check constraint/);
    await rejects(addReading(shipCol, { at: at(), humidity: 101 }), /check constraint/);
    await rejects(addReading(shipCol, { at: at(), lat: 6.9, lng: null }), /check constraint/);
    await rejects(addReading(shipCol, { at: at(), temperature: null, humidity: null }), /check constraint/);
    await rejects(addReading(shipCol, { at: at(), source: "manual" }), /check constraint/);
    assert.ok(await addReading(shipCol, { at: at(), temperature: null, humidity: null, lat: 6.9, lng: 79.8 }), "GPS only is fine");
  });

  test("the latest-readings view holds the newest reading of each shipment", async () => {
    await addReading(shipCol, { at: "now() - interval '5 minutes'", temperature: 6.5 });
    await addReading(shipCol, { at: "now() - interval '1 minute'", temperature: 7.25 });
    await addReading(shipCol, { at: "now() - interval '3 minutes'", temperature: 6 });
    const latest = await one("select temperature_c from cold_chain_latest_readings where shipment_id = $1", [shipCol]);
    assert.equal(Number(latest.temperature_c), 7.25);
    assert.equal((await one("select count(*)::int c from cold_chain_latest_readings")).c, 2);
  });
});

describe("alerts and predictions", () => {
  test("one active alert per condition; a resolved alert makes room for the next excursion", async () => {
    const first = await addAlert(shipCol, "temperature_excursion:above");
    await rejects(addAlert(shipCol, "temperature_excursion:above"), /cold_chain_alerts_active_key/);
    assert.ok(await addAlert(shipKdy, "temperature_excursion:above"), "other shipments are independent");
    await db.query("update cold_chain_alerts set status = 'resolved', resolved_at = now() where id = $1", [first.id]);
    assert.ok(await addAlert(shipCol, "temperature_excursion:above"));
  });

  test("predicted alerts must carry a probability", async () => {
    await rejects(addAlert(shipCol, "delivery_delay:predicted", { basis: "predicted" }), /check constraint/);
    assert.ok(await addAlert(shipCol, "delivery_delay:predicted", { basis: "predicted", probability: 0.82 }));
    await rejects(addAlert(shipCol, "x", { basis: "predicted", probability: 1.5 }), /check constraint/);
  });

  test("the latest-predictions view holds the newest prediction of each shipment", async () => {
    await addPrediction(shipCol, "now() - interval '10 minutes'");
    const newest = await addPrediction(shipCol, "now()");
    assert.equal((await one("select id from cold_chain_latest_predictions where shipment_id = $1", [shipCol])).id, newest.id);
  });

  test("trained predictions store the temperature and delay risk; a delay-only prediction has no fixed horizon", async () => {
    const row = await one(
      `insert into cold_chain_risk_predictions (shipment_id, pharmacy_id, model_name, model_version, is_prototype, risk_level, risk_probability,
         explanation, horizon_minutes, readings_used, temperature_risk, delay_risk, details, predicted_at)
       values ($1, (select pharmacy_id from cold_chain_shipments where shipment_id = $1), 'delay:logistic_regression', 'delay:v1', false, 'high', 0.82,
         'test', null, 40, null, 0.82, '{"combination": {"method": "max"}}', now() + interval '1 minute')
       returning *`,
      [shipCol]
    );
    assert.equal(row.horizon_minutes, null);
    const latest = await one("select temperature_risk, delay_risk, details from cold_chain_latest_predictions where shipment_id = $1", [shipCol]);
    assert.deepEqual([latest.temperature_risk, Number(latest.delay_risk), latest.details.combination.method], [null, 0.82, "max"]);
    await rejects(db.query("update cold_chain_risk_predictions set delay_risk = 1.5 where id = $1", [row.id]), /check constraint/);
    assert.deepEqual((await addPrediction(shipCol, "now() + interval '2 minutes'")).details, {}, "prototype rows keep the defaults");
  });
});

describe("row level security", () => {
  const visible = (user, table) => asUser(user, () => all(`select distinct shipment_id from ${table} order by 1`)).then((rows) => rows.map((r) => r.shipment_id).sort());
  const TABLES = ["cold_chain_shipments", "cold_chain_readings", "cold_chain_alerts", "cold_chain_latest_readings"];

  test("pharmacy staff read only shipments to their own pharmacy", async () => {
    for (const table of TABLES) {
      assert.deepEqual(await visible(colStaff, table), [shipCol], `${table} for Colombo staff`);
      assert.deepEqual(await visible(kdyStaff, table), [shipKdy], `${table} for Kandy staff`);
    }
    assert.deepEqual(await visible(colStaff, "cold_chain_risk_predictions"), [shipCol]);
    assert.deepEqual(await visible(kdyStaff, "cold_chain_risk_predictions"), []);
  });

  test("warehouse staff and admins read every shipment; plain users read none", async () => {
    const both = [shipCol, shipKdy].sort();
    for (const table of TABLES) {
      assert.deepEqual(await visible(whStaff, table), both, `${table} for warehouse staff`);
      assert.deepEqual(await visible(admin, table), both, `${table} for admins`);
      assert.deepEqual(await visible(plainUser, table), [], `${table} for plain users`);
    }
  });

  test("devices (key hashes) are not readable from the browser, and nothing is writable", async () => {
    await rejects(asUser(admin, () => all("select * from cold_chain_devices")), /permission denied/);
    await rejects(
      asUser(colStaff, () => db.query("insert into cold_chain_readings (shipment_id, pharmacy_id, source, recorded_at, temperature_c) values ($1, $2, 'device', now(), 5)", [shipCol, COL])),
      /permission denied/
    );
    await rejects(asUser(whStaff, () => db.query("update cold_chain_alerts set status = 'acknowledged'")), /permission denied/);
    await rejects(asUser(admin, () => db.query("delete from cold_chain_shipments")), /permission denied/);
  });
});

describe("trip workflow", () => {
  // tripA / tripB: dispatched here, monitored as ready for dispatch.
  let tripA, tripB, driver1, driver2, expiredDriver, reefer, sensorlessReefer, van, warmReefer, reeferDevice, driverUser1, driverUser2;
  const allocate = (shipment, driver, truck, device = null) =>
    one("select * from cold_chain_allocate_trip($1, $2, $3, $4, $5)", [shipment, driver, truck, device, whStaff]);
  const start = (shipment) => one("select * from cold_chain_start_trip($1, $2)", [shipment, whStaff]);
  const deliver = (shipment, notes = null, user = driverUser1) => one("select * from cold_chain_deliver_trip($1, $2, $3)", [shipment, user, notes]);
  const statusOf = async (table, id) => (await one(`select status from ${table} where id = $1`, [id])).status;
  const addDriver = (name, licence, expiry = "2030-01-01") =>
    one("insert into cold_chain_drivers (full_name, phone, licence_number, licence_expiry) values ($1, '+94 77 123 4567', $2, $3) returning *", [name, licence, expiry]);
  const addTruck = (reg, refrigerated, min = null, max = null, deviceId = null) =>
    one(
      "insert into cold_chain_trucks (registration_number, truck_type, is_refrigerated, min_temp_c, max_temp_c, device_id) values ($1, $2, $3, $4, $5, $6) returning *",
      [reg, refrigerated ? "refrigerated_truck" : "standard_van", refrigerated, min, max, deviceId]
    );

  before(async () => {
    tripA = (await dispatchOrder(COL, colStaff, "Metformin", 1)).id;
    tripB = (await dispatchOrder(KDY, kdyStaff, "Salbutamol", 1)).id;
    await monitor(tripA, null, { trip: "ready_for_dispatch" });
    await monitor(tripB, null, { trip: "ready_for_dispatch" });
    driver1 = await addDriver("Nimal Perera", "B1234567");
    driver2 = await addDriver("Kamal Silva", "B7654321");
    // Driver Portal accounts linked to the driver records.
    driverUser1 = await makeUser("nimal@test.local", "driver");
    driverUser2 = await makeUser("kamal@test.local", "driver");
    await db.query("update cold_chain_drivers set profile_id = $1 where id = $2", [driverUser1, driver1.id]);
    await db.query("update cold_chain_drivers set profile_id = $1 where id = $2", [driverUser2, driver2.id]);
    expiredDriver = await addDriver("Sunil Fernando", "B0000001", "2020-01-01");
    reeferDevice = await addDevice("ESP32-REEFER");
    reefer = await addTruck("WP-LA-1234", true, -20, 20, reeferDevice.id);
    van = await addTruck("WP-KA-5678", false);
    warmReefer = await addTruck("WP-CA-9999", true, 5, 15);
    sensorlessReefer = await addTruck("WP-LB-2222", true, -20, 20);
  });

  test("allocation is refused for missing, inactive or unlicensed drivers and unsuitable trucks", async () => {
    await rejects(allocate(tripA, "00000000-0000-4000-8000-000000000000", reefer.id), /Driver not found/);
    await rejects(allocate(tripA, driver1.id, "00000000-0000-4000-8000-000000000000"), /Truck not found/);
    await rejects(allocate(tripA, expiredDriver.id, reefer.id), /licence of Sunil Fernando expired/);
    await rejects(allocate(tripA, driver1.id, van.id), /WP-KA-5678 is not refrigerated/);
    await rejects(allocate(tripA, driver1.id, warmReefer.id), /WP-CA-9999 holds 5\.00 to 15\.00 °C/);
    await db.query("update cold_chain_drivers set status = 'inactive' where id = $1", [driver2.id]);
    await rejects(allocate(tripA, driver2.id, reefer.id), /Kamal Silva is inactive/);
    await db.query("update cold_chain_drivers set status = 'available' where id = $1", [driver2.id]);
    assert.equal((await one("select trip_status from cold_chain_shipments where shipment_id = $1", [tripA])).trip_status, "ready_for_dispatch");
  });

  test("allocation assigns driver, truck and the truck's sensor; a busy driver or truck is refused", async () => {
    const trip = await allocate(tripA, driver1.id, reefer.id);
    assert.deepEqual([trip.trip_status, trip.driver_id, trip.truck_id, trip.device_id], ["allocated", driver1.id, reefer.id, reeferDevice.id]);
    assert.ok(trip.allocated_at);
    assert.equal(await statusOf("cold_chain_drivers", driver1.id), "assigned");
    assert.equal(await statusOf("cold_chain_trucks", reefer.id), "assigned");
    await rejects(allocate(tripB, driver1.id, van.id), /Nimal Perera is not available \(assigned\)/);
    await rejects(allocate(tripB, driver2.id, reefer.id), /WP-LA-1234 is not available \(assigned\)/);
    // The indexes hold even if the functions were bypassed.
    await rejects(db.query("update cold_chain_shipments set driver_id = $1, truck_id = $2, trip_status = 'allocated' where shipment_id = $3", [driver1.id, van.id, tripB]), /cold_chain_shipments_live_driver/);
  });

  test("re-allocation before the start frees the previous driver", async () => {
    await allocate(tripA, driver2.id, reefer.id);
    assert.equal(await statusOf("cold_chain_drivers", driver1.id), "available");
    assert.equal(await statusOf("cold_chain_drivers", driver2.id), "assigned");
    await allocate(tripA, driver1.id, reefer.id);
    assert.equal(await statusOf("cold_chain_drivers", driver2.id), "available");
  });

  test("readings are refused until the trip starts; a trip needs a sensor to start", async () => {
    await rejects(addReading(tripA), /trip of this shipment has not started/);
    await allocate(tripB, driver2.id, sensorlessReefer.id);
    await rejects(start(tripB), /has no sensor device/);
  });

  test("starting the trip opens the reading window and puts driver and truck on the road", async () => {
    const trip = await start(tripA);
    assert.equal(trip.trip_status, "in_transit");
    assert.ok(trip.trip_started_at && trip.started_at);
    assert.equal(await statusOf("cold_chain_drivers", driver1.id), "on_trip");
    assert.equal(await statusOf("cold_chain_trucks", reefer.id), "in_use");
    assert.equal((await start(tripA)).trip_started_at.getTime(), trip.trip_started_at.getTime(), "starting again changes nothing");
    await rejects(allocate(tripA, driver2.id, reefer.id), /in transit; only shipments ready for dispatch or allocated/);
    await addReading(tripA, { at: "now() - interval '2 minutes'", temperature: 5.5, humidity: 60, lat: 6.91, lng: 79.86 });
    await addReading(tripA, { at: "now() - interval '1 minute'", temperature: 9.1, humidity: 90 });
  });

  test("only the assigned driver's account can confirm delivery, not staff, admins or another driver", async () => {
    for (const user of [whStaff, admin, driverUser2, null]) {
      await rejects(deliver(tripA, null, user), /Only the driver assigned to this shipment can confirm its delivery/);
    }
    assert.equal((await one("select trip_status from cold_chain_shipments where shipment_id = $1", [tripA])).trip_status, "in_transit");
  });

  test("delivery records the final readings, frees driver and truck and keeps the history", async () => {
    const trip = await deliver(tripA, "Handed to the pharmacist");
    assert.equal(trip.trip_status, "delivered");
    assert.ok(trip.delivered_at);
    assert.deepEqual([Number(trip.final_temperature_c), Number(trip.final_humidity_pct)], [9.1, 90]);
    assert.deepEqual([Number(trip.final_latitude), Number(trip.final_longitude)], [6.91, 79.86], "last GPS fix");
    assert.equal(trip.monitoring_status, "ended");
    assert.equal(trip.delivery_notes, "Handed to the pharmacist");
    assert.equal(await statusOf("cold_chain_drivers", driver1.id), "available");
    assert.equal(await statusOf("cold_chain_trucks", reefer.id), "available");
    assert.equal((await one("select count(*)::int c from cold_chain_readings where shipment_id = $1", [tripA])).c, 2);
    assert.equal((await deliver(tripA)).delivered_at.getTime(), trip.delivered_at.getTime(), "delivering again changes nothing");
    await rejects(start(tripA), /delivered; allocate a driver and a truck first/);
    // The freed driver and truck can take the next trip (re-allocating trip B frees its previous ones).
    const next = await allocate(tripB, driver1.id, reefer.id);
    assert.deepEqual([next.trip_status, next.device_id], ["allocated", reeferDevice.id]);
    assert.equal(await statusOf("cold_chain_drivers", driver2.id), "available");
    assert.equal(await statusOf("cold_chain_trucks", sensorlessReefer.id), "available");
  });

  test("the summary view counts readings, limit crossings and alerts per shipment", async () => {
    await addAlert(tripA, "temperature_excursion:above");
    const s = await one("select * from cold_chain_shipment_summaries where shipment_id = $1", [tripA]);
    assert.equal(s.readings, 2);
    assert.deepEqual([Number(s.temperature_min), Number(s.temperature_max), s.temperature_outside], [5.5, 9.1, 1]);
    assert.deepEqual([Number(s.humidity_max), s.humidity_outside], [90, 1]);
    assert.equal(s.alerts, 1);
  });

  test("drivers and trucks are visible to admins and warehouse staff only; the functions are backend-only", async () => {
    const count = (user, table) => asUser(user, () => one(`select count(*)::int c from ${table}`)).then((r) => r.c);
    assert.equal(await count(whStaff, "cold_chain_drivers"), 3);
    assert.equal(await count(admin, "cold_chain_trucks"), 4);
    assert.equal(await count(colStaff, "cold_chain_drivers"), 0);
    assert.equal(await count(plainUser, "cold_chain_trucks"), 0);
    await rejects(asUser(admin, () => start(tripB)), /permission denied/);
    await rejects(asUser(whStaff, () => db.query("update cold_chain_drivers set status = 'available'")), /permission denied/);
  });
});

describe("driver portal", () => {
  let tripB, nimal, kamal;
  before(async () => {
    tripB = (await one("select c.shipment_id from cold_chain_shipments c join cold_chain_drivers d on d.id = c.driver_id where d.full_name = 'Nimal Perera' and c.trip_status = 'allocated'")).shipment_id;
    nimal = (await one("select profile_id from cold_chain_drivers where full_name = 'Nimal Perera'")).profile_id;
    kamal = (await one("select profile_id from cold_chain_drivers where full_name = 'Kamal Silva'")).profile_id;
    await one("select * from cold_chain_start_trip($1, $2)", [tripB, whStaff]);
  });

  test("'driver' is a profile role and a driver record links to one account only", async () => {
    assert.equal((await one("select role from profiles where id = $1", [nimal])).role, "driver");
    await rejects(db.query("update cold_chain_drivers set profile_id = $1 where full_name = 'Kamal Silva'", [nimal]), /duplicate key/);
    await rejects(db.query("update profiles set role = 'courier' where id = $1", [nimal]), /profiles_role_check/);
  });

  test("a driver reads only their own trips, readings and issues (RLS)", async () => {
    const own = await asUser(nimal, () => all("select shipment_id from cold_chain_shipments"));
    assert.ok(own.length >= 2 && own.some((r) => r.shipment_id === tripB));
    assert.deepEqual(await asUser(kamal, () => all("select shipment_id from cold_chain_shipments")), [], "Kamal has no trip");
    assert.ok((await asUser(nimal, () => one("select count(*)::int c from cold_chain_readings"))).c >= 2);
    assert.equal((await asUser(kamal, () => one("select count(*)::int c from cold_chain_readings"))).c, 0);
    assert.equal((await asUser(nimal, () => one("select count(*)::int c from cold_chain_drivers"))).c, 1, "only their own driver record");
    await rejects(asUser(nimal, () => one("select * from cold_chain_deliver_trip($1, $2, null)", [tripB, nimal])), /permission denied/);
  });

  test("issues take the pharmacy of the shipment, are validated, and are visible to the driver and staff", async () => {
    const issue = await one(
      `insert into cold_chain_issues (shipment_id, pharmacy_id, driver_id, reported_by, issue_type, description, temperature_c)
       values ($1, $2, (select id from cold_chain_drivers where profile_id = $3), $3, 'temperature', 'Reefer unit alarm', 9.1) returning *`,
      [tripB, KDY, nimal]
    );
    assert.equal(issue.pharmacy_id, (await one("select pharmacy_id from shipments where id = $1", [tripB])).pharmacy_id);
    assert.equal(issue.status, "open");
    await rejects(db.query("insert into cold_chain_issues (shipment_id, pharmacy_id, issue_type, description) values ($1, $2, 'flat tyre', 'x y z')", [tripB, COL]), /check constraint/);
    await rejects(db.query("update cold_chain_issues set status = 'resolved' where id = $1", [issue.id]), /check constraint/, "resolved needs resolved_at");
    assert.equal((await asUser(nimal, () => one("select count(*)::int c from cold_chain_issues"))).c, 1);
    assert.equal((await asUser(kamal, () => one("select count(*)::int c from cold_chain_issues"))).c, 0);
    assert.equal((await asUser(whStaff, () => one("select count(*)::int c from cold_chain_issues"))).c, 1);
  });

  test("the assigned driver delivers their own trip", async () => {
    await rejects(one("select * from cold_chain_deliver_trip($1, $2, null)", [tripB, kamal]), /Only the driver assigned/);
    const trip = await one("select * from cold_chain_deliver_trip($1, $2, 'Delivered')", [tripB, nimal]);
    assert.deepEqual([trip.trip_status, trip.delivered_by], ["delivered", nimal]);
    assert.equal((await one("select status from cold_chain_drivers where profile_id = $1", [nimal])).status, "available");
  });
});

describe("Component 4 integration", () => {
  test("receiving a monitored shipment works as before; its monitoring and readings stay", async () => {
    const result = await one("select pharmacy_confirm_receipt($1, $2, $3, false) as r", [shipCol, COL, colStaff]).then((row) => row.r);
    assert.equal(result.status, "received");
    const row = await one("select c.monitoring_status, s.received_at from cold_chain_shipments c join shipments s on s.id = c.shipment_id where c.shipment_id = $1", [shipCol]);
    assert.equal(row.monitoring_status, "active");
    assert.ok(row.received_at, "actual delivery time comes from Component 4");
    assert.ok((await one("select count(*)::int c from cold_chain_readings where shipment_id = $1", [shipCol])).c > 0);
  });
});
