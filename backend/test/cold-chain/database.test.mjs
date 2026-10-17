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

const monitor = (shipmentId, deviceId, { isTest = false, pharmacyId = null } = {}) =>
  one(
    `insert into cold_chain_shipments (shipment_id, pharmacy_id, device_id, storage_condition, temp_min_c, temp_max_c, humidity_max_pct, is_test, started_at)
     values ($1, coalesce($2, (select pharmacy_id from shipments where id = $1)), $3, 'refrigerated', 2, 8, 85, $4, now() - interval '1 day')
     returning *`,
    [shipmentId, pharmacyId, deviceId, isTest]
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
    assert.deepEqual(published.map((r) => r.tablename), ["cold_chain_alerts", "cold_chain_readings", "cold_chain_risk_predictions", "cold_chain_shipments"]);
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
