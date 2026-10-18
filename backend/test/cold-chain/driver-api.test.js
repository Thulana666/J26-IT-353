// Driver Portal API authorization over HTTP, with a fake Supabase client:
// drivers see and deliver only their own trips; staff cannot confirm deliveries.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";
process.env.COLD_CHAIN_RISK_INTERVAL_MINUTES = "0";

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supabase = require("../../src/config/supabase");
const { installFakeSupabase, filterValue } = require("./fake-supabase");
const { coldChainRouter } = require("../../src/cold-chain");

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DRIVER_A = "d0000000-0000-4000-8000-00000000000a";
const DRIVER_B = "d0000000-0000-4000-8000-00000000000b";
const TRIP_A = "11111111-1111-4111-8111-111111111111";
const TRIP_A2 = "11111111-1111-4111-8111-222222222222";
const TRIP_B = "22222222-2222-4222-8222-222222222222";
const PHARMACY = "33333333-3333-4333-8333-333333333333";

const PROFILES = {
  [USER_A]: { role: "driver" },
  [USER_B]: { role: "driver" },
  [STAFF]: { role: "warehouse_staff" },
};
const LINKS = { [USER_A]: { id: DRIVER_A, full_name: "Nimal Perera" }, [USER_B]: { id: DRIVER_B, full_name: "Kamal Silva" } };

const trip = (shipmentId, driverId, tripStatus, number) => ({
  shipment_id: shipmentId,
  driver_id: driverId,
  pharmacy_id: PHARMACY,
  trip_status: tripStatus,
  expected_delivery_at: null,
  reading_interval_seconds: 60,
  monitoring_status: tripStatus === "delivered" ? "ended" : "active",
  is_test: false,
  temp_min_c: 2,
  temp_max_c: 8,
  pharmacy: { name: "Colombo pharmacy", address: "Colombo 07", phone: null, location: null },
  truck: { registration_number: "WP-LA-1234", truck_type: "refrigerated_truck", is_refrigerated: true, min_temp_c: -20, max_temp_c: 20 },
  shipment: { shipment_number: number, status: "in_transit", dispatched_at: new Date().toISOString(), received_at: null, purchase_order: { order_number: "PO-1" }, warehouse: { name: "Central" }, items: [] },
});
const TRIPS = [trip(TRIP_A, DRIVER_A, "in_transit", "SH-A"), trip(TRIP_A2, DRIVER_A, "allocated", "SH-A2"), trip(TRIP_B, DRIVER_B, "in_transit", "SH-B")];

let currentUser = USER_A;
let rpcCalls = [];
const log = installFakeSupabase(supabase, (q) => {
  if (q.table === "profiles") {
    return { data: { id: currentUser, email: "x@test.local", full_name: "X", status: "active", pharmacy_id: null, ...PROFILES[currentUser] }, error: null };
  }
  if (q.table === "cold_chain_drivers") return { data: LINKS[filterValue(q, "eq", "profile_id")] ?? null, error: null };
  if (q.table === "cold_chain_shipments") {
    // Like the database: only rows matching the filters.
    const driverId = filterValue(q, "eq", "driver_id");
    const shipmentId = filterValue(q, "eq", "shipment_id");
    const rows = TRIPS.filter((t) => (!driverId || t.driver_id === driverId) && (!shipmentId || t.shipment_id === shipmentId));
    return { data: q.single ? rows[0] ?? null : rows, error: null };
  }
  if (q.table === "cold_chain_issues" && q.op === "insert") {
    return { data: { id: "issue-1", ...q.payload, status: "open", created_at: new Date().toISOString(), driver: { full_name: "Nimal Perera" } }, error: null };
  }
  if (["cold_chain_latest_readings", "cold_chain_latest_predictions", "cold_chain_shipment_summaries", "cold_chain_alerts", "cold_chain_issues"].includes(q.table)) {
    return { data: q.single ? null : [], error: null };
  }
  if (q.table === "audit_logs") return { data: null, error: null };
  throw new Error(`unexpected query: ${q.op} ${q.table}`);
});
supabase.auth.getClaims = async () => ({ data: { claims: { sub: currentUser } }, error: null });
supabase.rpc = async (name, params) => {
  rpcCalls.push({ name, params });
  return { data: { trip_status: "delivered", delivered_at: new Date().toISOString(), final_temperature_c: "5.20", final_humidity_pct: "60.0", final_latitude: "6.9", final_longitude: "79.8" }, error: null };
};

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

async function as(user, path, { method = "GET", body } = {}) {
  currentUser = user;
  log.length = 0;
  rpcCalls = [];
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: "Bearer token", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("driver portal access", () => {
  test("staff accounts cannot use the portal; an unlinked driver account is told to get linked", async () => {
    const staff = await as(STAFF, "/driver/deliveries");
    assert.deepEqual([staff.status, staff.body.error], [403, "Only drivers can use the Driver Portal"]);
    LINKS.unlinked = null;
    PROFILES.unlinked = { role: "driver" };
    const unlinked = await as("unlinked", "/driver/deliveries");
    assert.equal(unlinked.status, 403);
    assert.match(unlinked.body.error, /not linked to a driver/);
  });

  test("Driver A sees only Driver A's deliveries, filtered by the database query", async () => {
    const { status, body } = await as(USER_A, "/driver/deliveries");
    assert.equal(status, 200);
    assert.equal(body.driver.fullName, "Nimal Perera");
    assert.deepEqual(body.active.map((d) => d.shipmentNumber), ["SH-A"]);
    assert.deepEqual(body.upcoming.map((d) => d.shipmentNumber), ["SH-A2"]);
    const query = log.find((q) => q.table === "cold_chain_shipments");
    assert.equal(filterValue(query, "eq", "driver_id"), DRIVER_A, "filtered on the server");
  });

  test("Driver B cannot open Driver A's delivery (404, as if it did not exist)", async () => {
    const own = await as(USER_B, `/driver/deliveries/${TRIP_B}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.delivery.shipmentNumber, "SH-B");
    const other = await as(USER_B, `/driver/deliveries/${TRIP_A}`);
    assert.deepEqual([other.status, other.body.error], [404, "Delivery not found"]);
  });
});

describe("delivery confirmation", () => {
  test("Driver A confirms their own delivery; the database call carries Driver A's account", async () => {
    const { status, body } = await as(USER_A, `/driver/deliveries/${TRIP_A}/deliver`, { method: "POST", body: { notes: "Handed over" } });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.result.status, "delivered");
    assert.equal(body.result.final.temperatureC, 5.2);
    assert.deepEqual(rpcCalls, [{ name: "cold_chain_deliver_trip", params: { p_shipment_id: TRIP_A, p_user_id: USER_A, p_notes: "Handed over" } }]);
    const closed = log.find((q) => q.table === "cold_chain_alerts" && q.op === "update");
    assert.equal(filterValue(closed, "eq", "basis"), "predicted", "predicted alerts close with the trip");
  });

  test("Driver A cannot confirm Driver B's delivery, nor a trip that has not started", async () => {
    const other = await as(USER_A, `/driver/deliveries/${TRIP_B}/deliver`, { method: "POST", body: {} });
    assert.equal(other.status, 404);
    assert.deepEqual(rpcCalls, []);
    const early = await as(USER_A, `/driver/deliveries/${TRIP_A2}/deliver`, { method: "POST", body: {} });
    assert.deepEqual([early.status, early.body.error], [409, "Only a delivery in transit can be confirmed"]);
  });

  test("warehouse staff cannot confirm a delivery through any endpoint", async () => {
    const staffPath = await as(STAFF, `/shipments/${TRIP_A}/deliver`, { method: "POST", body: {} });
    assert.deepEqual([staffPath.status, staffPath.body.error], [403, "Only the assigned driver can confirm delivery, in the Driver Portal"]);
    const driverPath = await as(STAFF, `/driver/deliveries/${TRIP_A}/deliver`, { method: "POST", body: {} });
    assert.equal(driverPath.status, 403);
    assert.deepEqual(rpcCalls, []);
  });
});

describe("issue reports", () => {
  test("Driver A reports an issue on their delivery; it is stored with driver and account", async () => {
    const { status, body } = await as(USER_A, `/driver/deliveries/${TRIP_A}/issues`, {
      method: "POST",
      body: { issueType: "temperature", description: "Reefer alarm went off" },
    });
    assert.equal(status, 201, JSON.stringify(body));
    const insert = log.find((q) => q.table === "cold_chain_issues" && q.op === "insert").payload;
    assert.deepEqual(
      [insert.shipment_id, insert.driver_id, insert.reported_by, insert.issue_type, insert.description],
      [TRIP_A, DRIVER_A, USER_A, "temperature", "Reefer alarm went off"]
    );
    assert.equal(body.issue.status, "open");
  });

  test("invalid issues and other drivers' deliveries are refused", async () => {
    const bad = await as(USER_A, `/driver/deliveries/${TRIP_A}/issues`, { method: "POST", body: { issueType: "flat tyre", description: "" } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.fields.issueType && bad.body.details.fields.description);
    const other = await as(USER_A, `/driver/deliveries/${TRIP_B}/issues`, { method: "POST", body: { issueType: "other", description: "Not mine" } });
    assert.equal(other.status, 404);
  });
});
