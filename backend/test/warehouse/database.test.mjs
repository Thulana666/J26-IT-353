// Database tests for Component 3: runs every migration and both sample seeds
// in PGlite (same Supabase stubs as the pharmacy tests), then checks storage
// rules, reservations, order fulfilment (allocate -> pick -> dispatch),
// receipt by the pharmacy, idempotency and row level security.
// Concurrency on a real server: concurrency.test.mjs.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  await db.query(
    "update public.profiles set role = $2, pharmacy_id = (select id from public.pharmacies where code = $3) where id = $1",
    [id, role, pharmacyCode]
  );
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

// record_inventory_movement() with named optional arguments.
const move = (batch, type, qty, { from = null, to = null, user = null, pick = null, requestId = null, compliant = null, reason = null } = {}) =>
  one(
    `select * from record_inventory_movement($1, $2, $3, $4, $5, $6, 'manual', $7, $8, null, null, current_date, $9, $10)`,
    [batch, type, qty, from, to, user, compliant, reason, pick, requestId]
  );

const stockAt = async (batch, location) =>
  (await one("select coalesce(sum(quantity), 0)::int q from warehouse_stock where batch_id = $1 and storage_location_id = $2", [batch, location])).q;

let WH, COL, admin, whStaff, colStaff, plainUser;
const loc = {};
const batch = {};
let MED, COLD_MED;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  const dir = path.join(ROOT, "supabase/migrations");
  for (const file of fs.readdirSync(dir).sort()) await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const file of ["sample_warehouse.sql", "sample_pharmacy.sql"]) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/seed", file), "utf8"));
  }
  WH = (await one("select id from warehouses where code = 'SAMPLE-CMB'")).id;
  COL = (await one("select id from pharmacies where code = 'SAMPLE-PH-COL'")).id;
  admin = await makeUser("admin@wh.test", "admin");
  whStaff = await makeUser("staff@wh.test", "warehouse_staff");
  colStaff = await makeUser("col@wh.test", "pharmacy_staff", "SAMPLE-PH-COL");
  plainUser = await makeUser("user@wh.test", "user");

  // Isolated fixtures: one medicine, a rack with three locations, three batches.
  MED = (await one("insert into medicines (name, strength, unit, units_per_pack) values ('TEST Cetirizine', '10 mg', 'carton', 10) returning id")).id;
  COLD_MED = (await one("insert into medicines (name, strength, storage_condition) values ('TEST Insulin', '100 IU', 'refrigerated') returning id")).id;
  const zoneA = (await one("select id from warehouse_zones where warehouse_id = $1 and code = 'A'", [WH])).id;
  const quarantine = (await one("select id from warehouse_zones where warehouse_id = $1 and code = 'Q'", [WH])).id;
  const rack = (await one("insert into warehouse_racks (zone_id, code, distance_to_dispatch_m) values ($1, 'T01', 5) returning id", [zoneA])).id;
  const qRack = (await one("insert into warehouse_racks (zone_id, code) values ($1, 'TQ1') returning id", [quarantine])).id;
  for (const [code, rackId, capacity] of [["T-1", rack, 100], ["T-2", rack, 100], ["T-3", rack, 40], ["TQ-1", qRack, 100]]) {
    loc[code] = (await one("insert into storage_locations (rack_id, code, capacity_units) values ($1, $2, $3) returning id", [rackId, code, capacity])).id;
  }
  for (const [no, days] of [["SHORT", 10], ["EARLY", 60], ["LATE", 300]]) {
    batch[no] = (await one(
      "insert into batches (medicine_id, batch_number, expiry_date, manufacturing_date) values ($1, $2, current_date + $3::int, current_date - 400) returning id",
      [MED, `TEST-${no}`, days]
    )).id;
  }
  await move(batch.SHORT, "receive", 20, { to: loc["T-1"] });
  await move(batch.EARLY, "receive", 30, { to: loc["T-2"] });
  await move(batch.LATE, "receive", 60, { to: loc["T-1"] });
});

const newOrder = async (quantity, medicine = MED) =>
  (await one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ medicineId: medicine, quantity }])])).id;

describe("storage rules (record_inventory_movement)", () => {
  test("capacity, storage condition and quarantine are enforced", async () => {
    await rejects(move(batch.LATE, "transfer", 41, { from: loc["T-1"], to: loc["T-3"] }), /space for 40/);
    const cold = (await one("insert into batches (medicine_id, batch_number, expiry_date) values ($1, 'TEST-COLD', current_date + 90) returning id", [COLD_MED])).id;
    await rejects(move(cold, "receive", 1, { to: loc["T-1"] }), /needs refrigerated storage/);
    await rejects(move(batch.LATE, "transfer", 1, { from: loc["T-1"], to: loc["TQ-1"] }), /quarantined before/);
    await rejects(move(batch.LATE, "dispatch", 1000, { from: loc["T-1"] }), /Not enough stock/);
  });

  test("a repeated client request id returns the first movement and moves stock once", async () => {
    const requestId = (await one("select gen_random_uuid() id")).id;
    const before = await stockAt(batch.LATE, loc["T-3"]);
    const first = await move(batch.LATE, "transfer", 5, { from: loc["T-1"], to: loc["T-3"], requestId });
    const again = await move(batch.LATE, "transfer", 5, { from: loc["T-1"], to: loc["T-3"], requestId });
    assert.equal(again.id, first.id);
    assert.equal(await stockAt(batch.LATE, loc["T-3"]), before + 5);
    await move(batch.LATE, "transfer", 5, { from: loc["T-3"], to: loc["T-1"] });
  });
});

describe("order fulfilment", () => {
  let order, ful, picks;

  test("allocation reserves FEFO stock and skips short-dated batches", async () => {
    order = await newOrder(40);
    ful = await one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]);
    assert.equal(ful.status, "allocated");
    picks = await all("select p.*, b.batch_number from warehouse_order_picks p join batches b on b.id = p.batch_id where fulfilment_id = $1 order by pick_sequence", [ful.id]);
    // SHORT (10 days) is below the 30-day pharmacy rule; EARLY then LATE.
    assert.deepEqual(picks.map((p) => [p.batch_number, p.quantity]), [["TEST-EARLY", 30], ["TEST-LATE", 10]]);
    assert.ok(picks.every((p) => p.fefo_compliant === false && /shelf life/.test(p.fefo_note)));
    const view = await one("select quantity, quantity_reserved, quantity_available from warehouse_stock_overview where batch_id = $1", [batch.EARLY]);
    assert.deepEqual(view, { quantity: 30, quantity_reserved: 30, quantity_available: 0 });
    // The pharmacy still sees the order as submitted.
    assert.equal((await one("select status from purchase_orders where id = $1", [order])).status, "submitted");
  });

  test("allocating again returns the same allocation", async () => {
    const again = await one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]);
    assert.equal(again.id, ful.id);
    assert.equal((await one("select count(*)::int c from warehouse_order_picks where fulfilment_id = $1", [ful.id])).c, 2);
  });

  test("reserved stock cannot be taken by transfers, disposals or other orders", async () => {
    await rejects(move(batch.EARLY, "transfer", 1, { from: loc["T-2"], to: loc["T-3"] }), /30 reserved for orders/);
    await rejects(move(batch.EARLY, "disposal", 1, { from: loc["T-2"] }), /reserved for orders/);
    // 60 LATE in T-1, 10 reserved: a second order for 55 cannot be allocated.
    const other = await newOrder(55);
    await rejects(one("select * from warehouse_allocate_order($1, $2)", [other, whStaff]), /Not enough unreserved stock.*50 of 55/);
    assert.equal((await one("select count(*)::int c from warehouse_order_fulfilments where order_id = $1", [other])).c, 0);
    // Component 4's direct dispatch cannot take reserved stock either.
    await rejects(one("select * from pharmacy_dispatch_order($1, $2)", [other, whStaff]), /unreserved stock/);
    await one("select * from pharmacy_cancel_order($1, $2, 'test')", [other, whStaff]);
  });

  test("a pick is confirmed only with the reserved batch and location", async () => {
    const [first, second] = picks;
    await rejects(one("select * from warehouse_confirm_pick($1, $2, $3, $4)", [first.id, whStaff, batch.LATE, first.storage_location_id]), /Wrong batch: .*TEST-EARLY/);
    await rejects(one("select * from warehouse_confirm_pick($1, $2, $3, $4)", [first.id, whStaff, first.batch_id, loc["T-3"]]), /Wrong location: .*T-2/);
    await rejects(one("select * from warehouse_dispatch_fulfilment($1, $2)", [ful.id, whStaff]), /Every pick must be verified/);

    await one("select * from warehouse_confirm_pick($1, $2, $3, $4)", [first.id, whStaff, first.batch_id, first.storage_location_id]);
    assert.equal((await one("select status from warehouse_order_fulfilments where id = $1", [ful.id])).status, "picking");
    const repeat = await one("select * from warehouse_confirm_pick($1, $2, $3, $4)", [first.id, whStaff, first.batch_id, first.storage_location_id]);
    assert.equal(repeat.status, "picked");
    await one("select * from warehouse_confirm_pick($1, $2, $3, $4, 'manual')", [second.id, whStaff, second.batch_id, second.storage_location_id]);
    assert.equal((await one("select status from warehouse_order_fulfilments where id = $1", [ful.id])).status, "ready");
  });

  test("dispatch creates the Component 4 shipment and consumes the reservations once", async () => {
    const lateBefore = await stockAt(batch.LATE, loc["T-1"]);
    const shipment = await one("select * from warehouse_dispatch_fulfilment($1, $2, 'test', $3::jsonb)", [
      ful.id, whStaff, JSON.stringify({ monitor: true, expectedDeliveryAt: "2030-01-01T10:00:00Z" }),
    ]);
    assert.equal(shipment.status, "in_transit");
    const items = await all("select b.batch_number, quantity_shipped, units_per_pack from shipment_items si join batches b on b.id = si.batch_id where shipment_id = $1 order by b.batch_number", [shipment.id]);
    assert.deepEqual(items, [
      { batch_number: "TEST-EARLY", quantity_shipped: 30, units_per_pack: 10 },
      { batch_number: "TEST-LATE", quantity_shipped: 10, units_per_pack: 10 },
    ]);
    assert.equal(await stockAt(batch.EARLY, loc["T-2"]), 0);
    assert.equal(await stockAt(batch.LATE, loc["T-1"]), lateBefore - 10);
    assert.equal((await one("select status from purchase_orders where id = $1", [order])).status, "dispatched");
    const movements = await all("select m.reference, m.fefo_compliant, m.fefo_override_reason from warehouse_order_picks p join inventory_movements m on m.id = p.movement_id where p.fulfilment_id = $1", [ful.id]);
    assert.equal(movements.length, 2);
    assert.ok(movements.every((m) => m.reference === shipment.shipment_number && m.fefo_compliant === false && m.fefo_override_reason));
    const event = await one("select status, payload from warehouse_integration_events where entity_id = $1", [shipment.id]);
    assert.equal(event.status, "pending");
    assert.equal(event.payload.expectedDeliveryAt, "2030-01-01T10:00:00Z");

    const again = await one("select * from warehouse_dispatch_fulfilment($1, $2)", [ful.id, whStaff]);
    assert.equal(again.id, shipment.id);
    assert.equal(await stockAt(batch.LATE, loc["T-1"]), lateBefore - 10);
    assert.equal((await one("select count(*)::int c from shipments where order_id = $1", [order])).c, 1);
  });

  test("the pharmacy's receipt confirmation adds the dispatched batches to pharmacy stock", async () => {
    const shipment = await one("select * from shipments where order_id = $1", [order]);
    const result = await one("select * from pharmacy_confirm_receipt($1, $2, $3)", [shipment.id, COL, colStaff]);
    assert.ok(result);
    const after = await one("select status from shipments where id = $1", [shipment.id]);
    assert.equal(after.status, "received");
    const stock = await one("select coalesce(sum(quantity_on_hand), 0)::int q from pharmacy_inventory where pharmacy_id = $1 and medicine_id = $2", [COL, MED]);
    assert.equal(stock.q, 400); // 40 packs x 10 units
    const items = await all("select quantity_accepted from shipment_items where shipment_id = $1", [shipment.id]);
    assert.deepEqual(items.map((i) => i.quantity_accepted).sort(), [10, 30]);
  });
});

describe("cancellation releases reservations", () => {
  test("cancelling an allocation releases its stock and allows re-allocation", async () => {
    const order = await newOrder(5);
    const ful = await one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]);
    await rejects(one("select * from warehouse_cancel_fulfilment($1, $2, '')", [ful.id, whStaff]), /reason/);
    const cancelled = await one("select * from warehouse_cancel_fulfilment($1, $2, 'wrong quantity')", [ful.id, whStaff]);
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await one("select count(*)::int c from warehouse_order_picks where fulfilment_id = $1 and status = 'released'", [ful.id])).c > 0, true);
    const again = await one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]);
    assert.notEqual(again.id, ful.id);
    await one("select * from warehouse_cancel_fulfilment($1, $2, 'clean up')", [again.id, whStaff]);
  });

  test("an order cancelled by the pharmacy releases the warehouse reservation", async () => {
    const order = await newOrder(5);
    const ful = await one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]);
    await one("select * from pharmacy_cancel_order($1, $2, 'not needed', $3)", [order, colStaff, COL]);
    const after = await one("select status, cancel_reason from warehouse_order_fulfilments where id = $1", [ful.id]);
    assert.equal(after.status, "cancelled");
    assert.match(after.cancel_reason, /not needed/);
    assert.equal((await one("select count(*)::int c from warehouse_order_picks where fulfilment_id = $1 and status in ('reserved','picked')", [ful.id])).c, 0);
  });

  test("a cancelled order cannot be allocated", async () => {
    const order = await newOrder(1);
    await one("select * from pharmacy_cancel_order($1, $2, 'x', $3)", [order, colStaff, COL]);
    await rejects(one("select * from warehouse_allocate_order($1, $2)", [order, whStaff]), /cancelled and cannot be allocated/);
  });
});

describe("loose FEFO dispatch", () => {
  test("dispatches in FEFO order, all or nothing, and once per request id", async () => {
    const requestId = (await one("select gen_random_uuid() id")).id;
    const total = (await one("select coalesce(sum(quantity_available), 0)::int q from warehouse_stock_overview where medicine_id = $1 and zone_type = 'storage' and expiry_date >= current_date", [MED])).q;
    await rejects(one("select warehouse_fefo_dispatch($1, $2, $3, $4) r", [WH, MED, total + 1, whStaff]), /Only \d+ unit\(s\) can be dispatched/);
    const result = (await one("select warehouse_fefo_dispatch($1, $2, 3, $3, 'DN-1', null, current_date, $4) r", [WH, MED, whStaff, requestId])).r;
    assert.equal(result.duplicate, false);
    // SHORT (10 days) is still eligible for loose dispatch and expires first.
    assert.equal(await stockAt(batch.SHORT, loc["T-1"]), 17);
    const repeat = (await one("select warehouse_fefo_dispatch($1, $2, 3, $3, 'DN-1', null, current_date, $4) r", [WH, MED, whStaff, requestId])).r;
    assert.equal(repeat.duplicate, true);
    assert.equal(await stockAt(batch.SHORT, loc["T-1"]), 17);
  });
});

describe("staff warehouse assignment", () => {
  test("a role without warehouse access loses its warehouse", async () => {
    await db.query("update profiles set warehouse_id = $2 where id = $1", [whStaff, WH]);
    assert.equal((await one("select warehouse_id from profiles where id = $1", [whStaff])).warehouse_id, WH);
    // e.g. changed from Component 4's settings page, which does not know about warehouses
    await db.query("update profiles set role = 'pharmacy_staff' where id = $1", [whStaff]);
    assert.equal((await one("select warehouse_id from profiles where id = $1", [whStaff])).warehouse_id, null);
    await db.query("update profiles set role = 'warehouse_staff' where id = $1", [whStaff]);
    // A warehouse cannot be set on a pharmacy staff account either.
    await db.query("update profiles set warehouse_id = $2 where id = $1", [colStaff, WH]);
    assert.equal((await one("select warehouse_id from profiles where id = $1", [colStaff])).warehouse_id, null);
  });
});

describe("row level security", () => {
  test("warehouse tables are readable by warehouse staff and admins only", async () => {
    for (const [user, expectRows] of [[whStaff, true], [admin, true], [colStaff, false], [plainUser, false]]) {
      const counts = await asUser(user, async () => ({
        stock: (await one("select count(*)::int c from warehouse_stock")).c,
        movements: (await one("select count(*)::int c from inventory_movements")).c,
        fulfilments: (await one("select count(*)::int c from warehouse_order_fulfilments")).c,
        view: (await one("select count(*)::int c from warehouse_stock_overview")).c,
        medicines: (await one("select count(*)::int c from medicines")).c,
      }));
      assert.equal(counts.stock > 0, expectRows, `stock for ${user}`);
      assert.equal(counts.movements > 0, expectRows);
      assert.equal(counts.fulfilments > 0, expectRows);
      assert.equal(counts.view > 0, expectRows);
      assert.ok(counts.medicines > 0, "shared medicines stay readable");
    }
  });

  test("users cannot call the fulfilment functions directly", async () => {
    await asUser(whStaff, () => rejects(db.query("select warehouse_allocate_order(gen_random_uuid(), null)"), /permission denied/));
    await asUser(whStaff, () => rejects(db.query("select record_inventory_movement(gen_random_uuid(), 'receive', 1)"), /permission denied/));
  });
});
