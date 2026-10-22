// Database tests for Component 4: runs every migration in supabase/migrations
// and both sample seeds in an in-memory PostgreSQL (PGlite), with minimal
// Supabase stubs (auth schema, API roles, realtime publication), then checks
// the transactional functions and the row level security policies.
//
// PGlite has one connection, so concurrency itself is not exercised here; the
// functions rely on row locks (SELECT ... FOR UPDATE), advisory locks and
// constraints for that.

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
const uuid = async () => (await one("select gen_random_uuid() as id")).id;
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

const inv = (pharmacy, batchNo) =>
  one("select i.* from pharmacy_inventory i join batches b on b.id = i.batch_id where i.pharmacy_id = $1 and b.batch_number = $2", [pharmacy, batchNo]);

const checkout = async (pharmacy, user, items, { discount = 0, method = "cash", tendered = 100000, requestId } = {}) =>
  one("select * from pharmacy_checkout($1, $2, $3, $4::jsonb, $5, $6, $7)", [
    pharmacy, user, requestId ?? (await uuid()), JSON.stringify(items), discount, method, tendered,
  ]);

let COL, KDY, admin, colStaff, kdyStaff, whStaff, plainUser;

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
});

describe("seed", () => {
  test("creates two sample pharmacies with consistent synthetic history", async () => {
    assert.equal((await one("select count(*)::int c from pharmacies where code like 'SAMPLE-PH-%'")).c, 2);
    assert.equal((await one("select count(*)::int c from sales where source = 'synthetic_seed'")).c, 360);
    assert.equal((await one("select count(*)::int c from shipments where status = 'in_transit'")).c, 1);
  });
});

describe("checkout", () => {
  test("prices and totals come from stored data; stock and ledger are updated", async () => {
    const before = await inv(COL, "SAMPLE-RX-PCM-C");
    const sale = await checkout(COL, colStaff, [{ batchId: before.batch_id, quantity: 4 }], { discount: 5 });
    assert.equal(Number(sale.subtotal), 140);
    assert.equal(Number(sale.discount_amount), 7);
    assert.equal(Number(sale.total_amount), 133);
    const after = await inv(COL, "SAMPLE-RX-PCM-C");
    assert.equal(after.quantity_on_hand, before.quantity_on_hand - 4);
    const movement = await one("select * from stock_movements where reference_id = $1", [sale.id]);
    assert.equal(movement.on_hand_after, after.quantity_on_hand);
    assert.equal((await one("select action from audit_logs where entity_id = $1", [sale.id])).action, "sale.completed");
  });

  test("a repeated request id returns the first sale and deducts stock once", async () => {
    const before = await inv(COL, "SAMPLE-RX-MET-C");
    const requestId = await uuid();
    const a = await checkout(COL, colStaff, [{ batchId: before.batch_id, quantity: 2 }], { requestId });
    const b = await checkout(COL, colStaff, [{ batchId: before.batch_id, quantity: 2 }], { requestId });
    assert.equal(a.id, b.id);
    assert.equal((await inv(COL, "SAMPLE-RX-MET-C")).quantity_on_hand, before.quantity_on_hand - 2);
  });

  test("refuses more than the available stock (also across merged lines) and keeps stock unchanged", async () => {
    const row = await inv(COL, "SAMPLE-RX-SAL-C");
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: row.quantity_on_hand + 1 }]), /Not enough stock/);
    const half = Math.ceil(row.quantity_on_hand / 2) + 1;
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: half }, { batchId: row.batch_id, quantity: half }]), /Not enough stock/);
    assert.equal((await inv(COL, "SAMPLE-RX-SAL-C")).quantity_on_hand, row.quantity_on_hand);
  });

  test("refuses expired batches and batches of another pharmacy", async () => {
    const expired = await inv(KDY, "SAMPLE-RX-NS-X");
    await rejects(checkout(KDY, kdyStaff, [{ batchId: expired.batch_id, quantity: 1 }]), /expired/);
    await rejects(checkout(COL, colStaff, [{ batchId: expired.batch_id, quantity: 1 }]), /not stocked at this pharmacy/);
  });

  test("validates discount limit, cash received and quantities", async () => {
    const row = await inv(COL, "SAMPLE-RX-PCM-C");
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: 1 }], { discount: 50 }), /Discount must be between 0% and 10.00%/);
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: 1 }], { tendered: 1 }), /less than the bill total/);
    await rejects(checkout(COL, colStaff, []), /empty/);
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: -1 }]), /positive whole numbers/);
    const card = await checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: 1 }], { method: "card", tendered: null });
    assert.equal(Number(card.change_due), 0);
  });
});

describe("receiving", () => {
  // shipA: the seeded in-transit shipment (paracetamol + ORS). shipB: created here.
  let shipA, shipB, itemsB;
  const confirm = (shipment, { partial = false, pharmacy = COL, user = colStaff } = {}) =>
    one("select pharmacy_confirm_receipt($1, $2, $3, $4) as r", [shipment.id, pharmacy, user, partial]).then((row) => row.r);
  const report = (shipment, { type, itemId = null, observed = null, notes = null, barcode = null, medicineId = null, requestId = null }) =>
    one("select pharmacy_report_discrepancy($1, $2, $3, $4, $5, $6, $7, $8, null, $9, $10) as r", [
      shipment.id, COL, colStaff, type, itemId, observed, notes, barcode, medicineId, requestId,
    ]).then((row) => row.r);
  const settle = (itemId, quantity) =>
    one("select pharmacy_settle_shipment_item($1, $2, $3, $4) as r", [itemId, COL, colStaff, quantity]).then((row) => row.r);
  const receiptMovements = (shipment) =>
    one("select count(*)::int c, coalesce(sum(on_hand_change), 0)::int units from stock_movements where reference_id = $1 and movement_type = 'receipt'", [shipment.id]);
  const batchStock = (batchId) =>
    one("select coalesce(sum(quantity_on_hand), 0)::int q from pharmacy_inventory where pharmacy_id = $1 and batch_id = $2", [COL, batchId]).then((r) => r.q);

  before(async () => {
    shipA = await one("select * from shipments where status = 'in_transit'");
    const met = (await one("select id from medicines where name = 'Metformin'")).id;
    const sal = (await one("select id from medicines where name = 'Salbutamol'")).id;
    const order = await one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ medicineId: met, quantity: 2 }, { medicineId: sal, quantity: 1 }])]);
    shipB = await one("select * from pharmacy_dispatch_order($1, $2)", [order.id, whStaff]);
    itemsB = await all("select si.*, m.name from shipment_items si join medicines m on m.id = si.medicine_id where shipment_id = $1", [shipB.id]);
  });

  test("only the shipment's own pharmacy can confirm it", async () => {
    await rejects(confirm(shipA, { pharmacy: KDY, user: kdyStaff }), /Shipment not found/);
  });

  test("a fully matching shipment is confirmed with the shipped quantities, without scanning", async () => {
    const items = await all("select si.*, b.batch_number from shipment_items si join batches b on b.id = si.batch_id where shipment_id = $1", [shipA.id]);
    const result = await confirm(shipA);
    assert.equal(result.already_processed, false);
    assert.equal(result.status, "received");
    assert.equal(result.items_accepted, items.length);
    for (const item of items) {
      assert.equal((await inv(COL, item.batch_number)).quantity_on_hand, item.quantity_shipped * item.units_per_pack);
      const row = await one("select verification_status, quantity_accepted, accepted_at from shipment_items where id = $1", [item.id]);
      assert.equal(row.verification_status, "matched");
      assert.equal(row.quantity_accepted, item.quantity_shipped);
      assert.ok(row.accepted_at);
    }
    assert.equal((await one("select status from purchase_orders where id = $1", [shipA.order_id])).status, "received");
    assert.equal((await one("select action from audit_logs where entity_id = $1 order by created_at desc limit 1", [shipA.id])).action, "shipment.received");
  });

  test("confirming again (double click, retry, second device) adds nothing", async () => {
    const before = await receiptMovements(shipA);
    const again = await confirm(shipA);
    assert.equal(again.already_processed, true);
    assert.equal(again.units_added, 0);
    assert.deepEqual(await receiptMovements(shipA), before);
  });

  test("a discrepancy report keeps the expected quantity from the shipment and never changes stock", async () => {
    const met = itemsB.find((i) => i.name === "Metformin");
    const stockBefore = await batchStock(met.batch_id);
    await rejects(report(shipB, { type: "missing", itemId: met.id, observed: 2, requestId: await uuid() }), /less than the 2 pack/);
    await rejects(report(shipB, { type: "damaged", itemId: met.id, observed: 5, requestId: await uuid() }), /1 to 2/);
    await rejects(report(shipB, { type: "missing", itemId: met.id, requestId: await uuid() }), /observed quantity/);
    const first = await report(shipB, { type: "missing", itemId: met.id, observed: 1, notes: "One carton missing", requestId: await uuid() });
    assert.equal(first.expected_quantity, 2, "expected comes from shipment_items, not the browser");
    assert.equal(first.actual_quantity, 1);
    assert.equal(first.duplicate, false);
    assert.equal((await one("select verification_status from shipment_items where id = $1", [met.id])).verification_status, "discrepancy");
    assert.equal(await batchStock(met.batch_id), stockBefore);
  });

  test("a repeated submission returns the first report; a genuinely new report is saved separately", async () => {
    const met = itemsB.find((i) => i.name === "Metformin");
    const requestId = await uuid();
    const a = await report(shipB, { type: "damaged", itemId: met.id, observed: 1, notes: "Crushed carton", requestId });
    const b = await report(shipB, { type: "damaged", itemId: met.id, observed: 1, notes: "Crushed carton", requestId });
    assert.equal(b.duplicate, true);
    assert.equal(b.id, a.id);
    const c = await report(shipB, { type: "damaged", itemId: met.id, observed: 1, notes: "Second crushed carton", requestId: await uuid() });
    assert.notEqual(c.id, a.id);
    assert.equal((await one("select count(*)::int c from shipment_discrepancies where shipment_id = $1 and discrepancy_type = 'damaged'", [shipB.id])).c, 2);
  });

  test("an unknown item is recorded without inventing product or batch details", async () => {
    await rejects(report(shipB, { type: "incorrect_item", observed: 1, requestId: await uuid() }), /Describe the unknown item/);
    const unknown = await report(shipB, { type: "incorrect_item", observed: 1, barcode: "9999999999999", notes: "Unlabelled carton", requestId: await uuid() });
    assert.equal(unknown.medicine_id, null);
    assert.equal(unknown.batch_id, null);
    assert.equal(unknown.shipment_item_id, null);
    assert.equal(unknown.observed_barcode, "9999999999999");
    assert.equal(unknown.expected_quantity, 0);
  });

  test("a shipment with discrepancies cannot be confirmed as fully correct", async () => {
    await rejects(confirm(shipB), /discrepancy report\(s\), so it cannot be confirmed as fully correct/);
    assert.equal((await one("select status from shipments where id = $1", [shipB.id])).status, "in_transit");
  });

  test("accepting verified items adds only undisputed items; the disputed item stays out of stock", async () => {
    const met = itemsB.find((i) => i.name === "Metformin");
    const sal = itemsB.find((i) => i.name === "Salbutamol");
    const salBefore = await batchStock(sal.batch_id);
    const metBefore = await batchStock(met.batch_id);
    const result = await confirm(shipB, { partial: true });
    assert.equal(result.status, "received_with_discrepancies");
    assert.equal(result.items_accepted, 1);
    assert.equal(result.items_held, 1);
    assert.equal(await batchStock(sal.batch_id), salBefore + sal.quantity_shipped * sal.units_per_pack);
    assert.equal(await batchStock(met.batch_id), metBefore, "disputed packs never reach stock");
    const held = await one("select verification_status, quantity_accepted from shipment_items where id = $1", [met.id]);
    assert.deepEqual(held, { verification_status: "discrepancy", quantity_accepted: null });
    assert.equal((await confirm(shipB, { partial: true })).already_processed, true);
  });

  test("a held item is accepted only after the warehouse resolves its reports, once, up to the shipped quantity", async () => {
    const met = itemsB.find((i) => i.name === "Metformin");
    const sal = itemsB.find((i) => i.name === "Salbutamol");
    await rejects(settle(met.id, 1), /has not resolved report/);
    const reports = await all("select id from shipment_discrepancies where shipment_item_id = $1", [met.id]);
    for (const r of reports) await one("select * from pharmacy_update_discrepancy($1, $2, 'resolved', 'Credit note issued for the missing carton')", [r.id, whStaff]);
    await rejects(settle(met.id, 3), /between 0 and the 2 shipped/);
    const done = await settle(met.id, 1);
    assert.equal(done.already_processed, false);
    assert.equal(done.units_added, met.units_per_pack);
    assert.equal((await settle(met.id, 1)).already_processed, true);
    assert.equal((await receiptMovements(shipB)).units, met.units_per_pack + sal.quantity_shipped * sal.units_per_pack);
  });

  test("warehouse staff acknowledge, then resolve with notes", async () => {
    const d = await one("select * from shipment_discrepancies where shipment_item_id is null and shipment_id = $1", [shipB.id]);
    await rejects(one("select * from pharmacy_update_discrepancy($1, $2, 'resolved', null)", [d.id, whStaff]), /Describe how/);
    assert.equal((await one("select * from pharmacy_update_discrepancy($1, $2, 'acknowledged', null)", [d.id, whStaff])).status, "acknowledged");
    assert.equal((await one("select * from pharmacy_update_discrepancy($1, $2, 'resolved', 'Carton collected')", [d.id, whStaff])).status, "resolved");
  });
});

describe("FEFO at checkout", () => {
  test("selling a later batch while an earlier sellable batch exists is recorded as not FEFO-compliant", async () => {
    const early = await inv(COL, "SAMPLE-PCM-2409"); // received above; expires within months
    const late = await inv(COL, "SAMPLE-RX-PCM-C");
    const notFefo = await checkout(COL, colStaff, [{ batchId: late.batch_id, quantity: 1 }]);
    assert.equal((await one("select fefo_compliant from sale_items where sale_id = $1", [notFefo.id])).fefo_compliant, false);
    const fefo = await checkout(COL, colStaff, [{ batchId: early.batch_id, quantity: 1 }]);
    assert.equal((await one("select fefo_compliant from sale_items where sale_id = $1", [fefo.id])).fefo_compliant, true);
  });
});

describe("discrepancy holds after acceptance", () => {
  let shipA, pcmItem, orsItem;
  const report = (type, itemId, observed, notes = "Found when unpacking") =>
    one("select pharmacy_report_discrepancy($1, $2, $3, $4, $5, $6, $7, null, null, null, gen_random_uuid()) as r", [
      shipA.id, COL, colStaff, type, itemId, observed, notes,
    ]).then((row) => row.r);
  const settleHold = (reportId, outcome) =>
    one("select pharmacy_settle_discrepancy_hold($1, $2, $3, $4) as r", [reportId, COL, colStaff, outcome]).then((row) => row.r);
  const resolve = (reportId) =>
    one("select * from pharmacy_update_discrepancy($1, $2, 'resolved', 'Checked by the warehouse')", [reportId, whStaff]);
  const stock = (batchNumber) =>
    one(
      `select i.quantity_on_hand, i.quantity_reserved, i.quantity_held, v.quantity_available from pharmacy_inventory i
       join batches b on b.id = i.batch_id join pharmacy_inventory_overview v on v.inventory_id = i.id
       where i.pharmacy_id = $1 and b.batch_number = $2`,
      [COL, batchNumber]
    );

  before(async () => {
    shipA = await one("select * from shipments where shipment_number = 'SH-000001'");
    const items = await all("select si.*, b.batch_number from shipment_items si join batches b on b.id = si.batch_id where shipment_id = $1", [shipA.id]);
    pcmItem = items.find((i) => i.batch_number.startsWith("SAMPLE-PCM"));
    orsItem = items.find((i) => i.batch_number.startsWith("SAMPLE-ORS"));
  });

  test("a problem found after acceptance holds the disputed units out of available stock", async () => {
    const before = await stock(pcmItem.batch_number);
    const missing = await report("missing", pcmItem.id, 2, "Only 2 of 3 cartons were in the delivery");
    assert.equal(missing.held_units, pcmItem.units_per_pack, "1 missing carton = 100 strips held");
    const after = await stock(pcmItem.batch_number);
    assert.equal(after.quantity_on_hand, before.quantity_on_hand, "on hand unchanged until written off");
    assert.equal(after.quantity_held, before.quantity_held + 100);
    assert.equal(after.quantity_available, before.quantity_available - 100);
    const movement = await one("select movement_type, held_change, held_after from stock_movements where reference_id = $1", [missing.id]);
    assert.deepEqual(movement, { movement_type: "discrepancy_hold", held_change: 100, held_after: after.quantity_held });
  });

  test("held units cannot be sold, returned or adjusted away", async () => {
    const s = await stock(pcmItem.batch_number);
    const row = await inv(COL, pcmItem.batch_number);
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: s.quantity_available + 1 }]), /Not enough stock/);
    await rejects(
      one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ inventoryId: row.id, quantity: s.quantity_available + 1, reason: "overstock" }])]),
      /reserved for returns or held by discrepancy reports/
    );
    await rejects(
      one("select * from pharmacy_adjust_stock($1, $2, -($3::int), $4, 'count')", [COL, row.batch_id, s.quantity_available + 1, admin]),
      /held by discrepancy reports/
    );
  });

  test("held units are written off or released only after the warehouse resolves the report, once", async () => {
    const missing = await one("select id from shipment_discrepancies where shipment_id = $1 and discrepancy_type = 'missing' and shipment_item_id = $2 order by reported_at desc limit 1", [shipA.id, pcmItem.id]);
    await rejects(settleHold(missing.id, "write_off"), /has not resolved report/);
    await resolve(missing.id);
    const before = await stock(pcmItem.batch_number);
    const done = await settleHold(missing.id, "write_off");
    assert.deepEqual(done, { already_processed: false, outcome: "write_off", units: 100 });
    const after = await stock(pcmItem.batch_number);
    assert.equal(after.quantity_on_hand, before.quantity_on_hand - 100);
    assert.equal(after.quantity_held, before.quantity_held - 100);
    assert.equal(after.quantity_available, before.quantity_available, "write-off removes units that were already unavailable");
    assert.equal((await settleHold(missing.id, "write_off")).already_processed, true);
    assert.equal((await settleHold(missing.id, "release")).already_processed, true);
    assert.deepEqual(await stock(pcmItem.batch_number), after);
  });

  test("damaged units held after acceptance go back to available stock when released", async () => {
    const before = await stock(orsItem.batch_number);
    const damaged = await report("damaged", orsItem.id, 1, "Carton wet");
    assert.equal(damaged.held_units, 100);
    await resolve(damaged.id);
    const released = await settleHold(damaged.id, "release");
    assert.equal(released.units, 100);
    assert.deepEqual(await stock(orsItem.batch_number), before);
  });

  test("a hold never exceeds the units still available", async () => {
    const s = await stock(pcmItem.batch_number);
    const wrong = await report("incorrect_batch", pcmItem.id, 3, "Three cartons carry another batch number");
    assert.equal(wrong.held_units, Math.min(3 * pcmItem.units_per_pack, s.quantity_available));
    assert.equal((await stock(pcmItem.batch_number)).quantity_available, s.quantity_available - wrong.held_units);
    await resolve(wrong.id);
    await settleHold(wrong.id, "release");
  });

  test("the migration holds existing unresolved reports once (backfill)", async () => {
    const before = await stock(orsItem.batch_number);
    const legacy = await one(
      `insert into shipment_discrepancies (shipment_id, shipment_item_id, order_id, pharmacy_id, medicine_id, batch_id, discrepancy_type, expected_quantity, actual_quantity, notes)
       values ($1, $2, $3, $4, $5, $6, 'missing', 1, 0, 'Reported before holds existed') returning id`,
      [shipA.id, orsItem.id, shipA.order_id, COL, orsItem.medicine_id, orsItem.batch_id]
    );
    const migration = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261016000000_pharmacy_inventory_holds.sql"), "utf8");
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await stock(orsItem.batch_number)).quantity_held, before.quantity_held + 100);
    assert.equal((await one("select count(*)::int c from stock_movements where reference_id = $1", [legacy.id])).c, 1);
    assert.equal((await one("select action from audit_logs where entity_id = $1", [legacy.id])).action, "discrepancy.hold_backfilled");
  });
});

describe("orders and dispatch", () => {
  const medicine = async (name) => (await one("select id from medicines where name = $1", [name])).id;
  const order = async (pharmacy, user, items) => one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [pharmacy, user, JSON.stringify(items)]);

  test("dispatch picks FEFO from warehouse stock and logs skipped short-dated stock as an override", async () => {
    const movements = await all("select fefo_compliant, fefo_override_reason from inventory_movements where reference like 'SH-%' and movement_type = 'dispatch'");
    assert.ok(movements.some((m) => m.fefo_compliant === false && /shelf life/.test(m.fefo_override_reason)));
  });

  test("refuses to dispatch without enough long-dated stock, leaving the order open", async () => {
    const o = await order(COL, colStaff, [{ medicineId: await medicine("Oxytocin"), quantity: 1 }]);
    await rejects(one("select * from pharmacy_dispatch_order($1, $2)", [o.id, whStaff]), /Not enough stock of Oxytocin/);
    assert.equal((await one("select status from purchase_orders where id = $1", [o.id])).status, "submitted");
    assert.equal((await one("select * from pharmacy_cancel_order($1, $2, 'No stock', null)", [o.id, whStaff])).status, "cancelled");
  });

  test("partial dispatch ships at most the ordered quantity, once", async () => {
    const o = await order(KDY, kdyStaff, [{ medicineId: await medicine("Metformin"), quantity: 3 }]);
    const item = await one("select id from purchase_order_items where order_id = $1", [o.id]);
    await rejects(one("select * from pharmacy_dispatch_order($1, $2, $3::jsonb)", [o.id, whStaff, JSON.stringify([{ orderItemId: item.id, quantity: 4 }])]), /Ship between 0 and 3/);
    const sh = await one("select * from pharmacy_dispatch_order($1, $2, $3::jsonb)", [o.id, whStaff, JSON.stringify([{ orderItemId: item.id, quantity: 2 }])]);
    assert.equal((await one("select sum(quantity_shipped)::int q from shipment_items where shipment_id = $1", [sh.id])).q, 2);
    await rejects(one("select * from pharmacy_dispatch_order($1, $2)", [o.id, whStaff]), /cannot be dispatched/);
  });

  test("an order line records the decision on its recommendation; one pending recommendation per product", async () => {
    const sal = await medicine("Salbutamol");
    const row = {
      medicine_id: sal, model_name: "moving_average", is_provisional: false, forecast_daily_demand: 2.6, lead_time_days: 4,
      review_period_days: 7, lead_time_demand: 10.4, review_period_demand: 18.2, safety_stock: 5, reorder_point: 15.4, target_stock: 33.6,
      on_hand_usable: 14, reserved: 0, incoming: 0, inventory_position: 14, stockout_risk: "medium", needs_reorder: true,
      raw_quantity: 19.6, recommended_units: 20, recommended_packs: 1, explanation: "test",
    };
    await one("select pharmacy_publish_recommendations($1, $2::jsonb)", [KDY, JSON.stringify([row])]);
    await one("select pharmacy_publish_recommendations($1, $2::jsonb)", [KDY, JSON.stringify([row])]);
    const counts = await one("select count(*) filter (where status = 'pending')::int p, count(*) filter (where status = 'superseded')::int s from reorder_recommendations where pharmacy_id = $1 and medicine_id = $2", [KDY, sal]);
    assert.deepEqual(counts, { p: 1, s: 1 });
    const rec = await one("select * from reorder_recommendations where pharmacy_id = $1 and status = 'pending'", [KDY]);
    await order(KDY, kdyStaff, [{ medicineId: sal, quantity: 2, recommendationId: rec.id }]);
    const decided = await one("select * from reorder_recommendations where id = $1", [rec.id]);
    assert.equal(decided.status, "edited");
    assert.equal(decided.decided_packs, 2);
  });
});

describe("returns", () => {
  test("reserve on request; reserved stock cannot be sold or returned again", async () => {
    const row = await inv(COL, "SAMPLE-RX-PCM-C");
    const ret = await one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ inventoryId: row.id, quantity: 100, reason: "overstock" }])]);
    assert.equal(ret.status, "pending");
    const held = await inv(COL, "SAMPLE-RX-PCM-C");
    assert.equal(held.quantity_reserved, row.quantity_reserved + 100);
    assert.equal(held.quantity_on_hand, row.quantity_on_hand);
    const available = held.quantity_on_hand - held.quantity_reserved;
    await rejects(checkout(COL, colStaff, [{ batchId: row.batch_id, quantity: available + 1 }]), /Not enough stock/);
    await rejects(one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ inventoryId: row.id, quantity: available + 1, reason: "overstock" }])]), /can be returned/);
  });

  test("rejection (with a reason) releases the reservation", async () => {
    const row = await inv(COL, "SAMPLE-RX-PCM-C");
    const ret = await one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ inventoryId: row.id, quantity: 3, reason: "damaged" }])]);
    await rejects(one("select * from pharmacy_review_return($1, $2, 'reject', null)", [ret.id, whStaff]), /reason for rejecting/);
    await one("select * from pharmacy_review_return($1, $2, 'reject', 'Not damaged')", [ret.id, whStaff]);
    const after = await inv(COL, "SAMPLE-RX-PCM-C");
    assert.equal(after.quantity_reserved, row.quantity_reserved);
    await rejects(one("select * from pharmacy_receive_return($1, $2)", [ret.id, whStaff]), /cannot be received/);
  });

  test("warehouse receipt removes the stock from the pharmacy and restocks whole packs", async () => {
    const ret = await one("select * from return_requests where pharmacy_id = $1 and status = 'pending' and notes is null", [COL]);
    const item = await one("select * from return_items where return_id = $1", [ret.id]);
    const before = await one("select * from pharmacy_inventory where id = $1", [item.inventory_id]);
    const location = await one("select storage_location_id id from storage_location_overview where location_code = 'A04-L1-P1'");
    const warehouseBefore = await one("select coalesce(sum(quantity), 0)::int q from warehouse_stock where batch_id = $1", [item.batch_id]);
    await one("select * from pharmacy_review_return($1, $2, 'approve', null)", [ret.id, whStaff]);
    await one("select * from pharmacy_receive_return($1, $2, $3::jsonb)", [ret.id, whStaff, JSON.stringify([{ returnItemId: item.id, locationId: location.id }])]);
    const after = await one("select * from pharmacy_inventory where id = $1", [item.inventory_id]);
    assert.equal(after.quantity_on_hand, before.quantity_on_hand - 100);
    assert.equal(after.quantity_reserved, before.quantity_reserved - 100);
    const warehouseAfter = await one("select coalesce(sum(quantity), 0)::int q from warehouse_stock where batch_id = $1", [item.batch_id]);
    assert.equal(warehouseAfter.q, warehouseBefore.q + 1, "100 strips = 1 carton");

    // Repeated confirmation (retry, double click, second warehouse device): no second transfer.
    const movementsBefore = await one("select count(*)::int c from stock_movements where reference_id = $1", [ret.id]);
    const again = await one("select * from pharmacy_receive_return($1, $2, $3::jsonb)", [ret.id, whStaff, JSON.stringify([{ returnItemId: item.id, locationId: location.id }])]);
    assert.equal(again.status, "received");
    assert.deepEqual(await one("select * from pharmacy_inventory where id = $1", [item.inventory_id]), after);
    assert.equal((await one("select coalesce(sum(quantity), 0)::int q from warehouse_stock where batch_id = $1", [item.batch_id])).q, warehouseAfter.q);
    assert.deepEqual(await one("select count(*)::int c from stock_movements where reference_id = $1", [ret.id]), movementsBefore);
    // Approving or rejecting is idempotent too, and a received return cannot be rejected.
    await rejects(one("select * from pharmacy_review_return($1, $2, 'reject', 'Too late')", [ret.id, whStaff]), /is received and cannot be rejected/);
  });

  test("submitting a return does not deduct stock; repeated review decisions change nothing", async () => {
    const row = await inv(COL, "SAMPLE-RX-PCM-C");
    const ret = await one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, colStaff, JSON.stringify([{ inventoryId: row.id, quantity: 2, reason: "damaged" }])]);
    const held = await inv(COL, "SAMPLE-RX-PCM-C");
    assert.equal(held.quantity_on_hand, row.quantity_on_hand, "on hand unchanged until the warehouse receives it");
    await one("select * from pharmacy_review_return($1, $2, 'approve', null)", [ret.id, whStaff]);
    assert.equal((await one("select * from pharmacy_review_return($1, $2, 'approve', null)", [ret.id, whStaff])).status, "approved");
    await one("select * from pharmacy_review_return($1, $2, 'reject', 'Not damaged')", [ret.id, whStaff]);
    await one("select * from pharmacy_review_return($1, $2, 'reject', 'Not damaged')", [ret.id, whStaff]);
    const released = await inv(COL, "SAMPLE-RX-PCM-C");
    assert.equal(released.quantity_reserved, row.quantity_reserved, "released once, not twice");
  });

  test("expired returns are received without restock; the batch row stays at zero", async () => {
    const ret = await one("select * from return_requests where pharmacy_id = $1 and status = 'pending'", [KDY]);
    assert.equal((await one("select * from pharmacy_receive_return($1, $2)", [ret.id, whStaff])).status, "received");
    const row = await inv(KDY, "SAMPLE-RX-NS-X");
    assert.equal(row.quantity_on_hand, 0);
    assert.equal(row.quantity_reserved, 0);
  });
});

describe("demand model runs", () => {
  test("runs and forecasts can record the linear regression; unknown models are still refused", async () => {
    const run = await one("insert into pharmacy_forecast_runs (pharmacy_id, engine, horizon_days) values ($1, 'linear_regression', 30) returning id", [COL]);
    const medicine = (await one("select id from medicines where name = 'Paracetamol'")).id;
    const insertForecast = (model, day) =>
      db.query(
        "insert into pharmacy_demand_forecasts (run_id, pharmacy_id, medicine_id, forecast_date, predicted_quantity, model_name) values ($1, $2, $3, current_date + $5::int, 5, $4)",
        [run.id, COL, medicine, model, day]
      );
    await insertForecast("linear_regression", 0);
    await insertForecast("moving_average", 1);
    await assert.rejects(insertForecast("neural_net", 2), /check constraint/);
    await assert.rejects(db.query("insert into pharmacy_forecast_runs (pharmacy_id, engine, horizon_days) values ($1, 'magic', 30)", [COL]), /check constraint/);
    await db.query("delete from pharmacy_forecast_runs where id = $1", [run.id]);
  });
});

describe("ledger and demand", () => {
  test("inventory (on hand, reserved, held) always equals the sum of its stock movements", async () => {
    const r = await one(`select count(*) filter (where i.quantity_on_hand <> coalesce(x.s, 0) or i.quantity_reserved <> coalesce(x.r, 0) or i.quantity_held <> coalesce(x.h, 0))::int bad
      from pharmacy_inventory i left join (select inventory_id, sum(on_hand_change) s, sum(reserved_change) r, sum(held_change) h from stock_movements group by 1) x on x.inventory_id = i.id`);
    assert.equal(r.bad, 0);
  });

  test("daily demand totals match sales and stockout days are flagged", async () => {
    const rows = await all("select * from pharmacy_daily_demand($1, current_date - 180, current_date - 1)", [KDY]);
    const sal = (await one("select id from medicines where name = 'Salbutamol'")).id;
    assert.ok(rows.filter((r) => r.medicine_id === sal && r.closing_on_hand === 0).length > 0);
    const expected = await one("select sum(quantity)::int q from sale_items where pharmacy_id = $1 and sold_at < (current_date::timestamp at time zone 'Asia/Colombo')", [KDY]);
    assert.equal(rows.reduce((t, r) => t + r.quantity_sold, 0), expected.q);
  });
});

describe("row level security", () => {
  const count = async (table) => (await one(`select count(*)::int c from ${table}`)).c;

  test("pharmacy staff read only their own pharmacy", async () => {
    await asUser(colStaff, async () => {
      assert.deepEqual((await all("select code from pharmacies")).map((p) => p.code), ["SAMPLE-PH-COL"]);
      const seen = await all("select distinct pharmacy_id from sales union select distinct pharmacy_id from pharmacy_inventory union select distinct pharmacy_id from purchase_orders");
      assert.deepEqual(seen.map((r) => r.pharmacy_id), [COL]);
    });
  });

  test("warehouse staff read orders, shipments, discrepancies and returns, not sales or stock", async () => {
    await asUser(whStaff, async () => {
      assert.equal(await count("sales"), 0);
      assert.equal(await count("pharmacy_inventory"), 0);
      assert.ok((await count("purchase_orders")) > 0);
      assert.ok((await count("shipment_discrepancies")) > 0);
      assert.ok((await count("return_requests")) > 0);
    });
  });

  test("plain users see no pharmacy data; admins see every pharmacy", async () => {
    await asUser(plainUser, async () => {
      for (const t of ["pharmacies", "sales", "purchase_orders", "pharmacy_inventory", "audit_logs"]) assert.equal(await count(t), 0, t);
    });
    await asUser(admin, async () => assert.equal((await one("select count(distinct pharmacy_id)::int c from sales")).c, 2));
  });

  test("signed-in users cannot write stock, sales or roles, or call the functions", async () => {
    await asUser(colStaff, async () => {
      await rejects(db.query("update pharmacy_inventory set quantity_on_hand = 999"), /permission denied/);
      await rejects(db.query("insert into sales (pharmacy_id, subtotal, total_amount) values ($1, 0, 0)", [COL]), /permission denied/);
      await rejects(db.query("select pharmacy_checkout($1, $2, gen_random_uuid(), '[]'::jsonb)", [COL, colStaff]), /permission denied/);
      await rejects(db.query("update profiles set role = 'admin'"), /permission denied/);
    });
  });

  test("inactive accounts lose access", async () => {
    await db.query("update profiles set status = 'inactive' where id = $1", [kdyStaff]);
    await asUser(kdyStaff, async () => assert.equal(await count("pharmacies"), 0));
  });
});

// Runs last: it removes the generated history the other tests rely on.
describe("removing the synthetic history (before evaluation)", () => {
  const script = () => fs.readFileSync(path.join(ROOT, "supabase/seed/remove_synthetic_history.sql"), "utf8");
  const stock = () => all("select id, quantity_on_hand, quantity_reserved, quantity_held from pharmacy_inventory order by id");

  test("keeps current stock and real transactions; the ledger still adds up; re-running changes nothing", async () => {
    const before = await stock();
    const realSales = await one("select count(*)::int c from sales where source = 'pos'");
    const realMovements = await one("select count(*)::int c from stock_movements where coalesce(notes, '') not like 'SAMPLE synthetic%'");
    assert.ok((await one("select count(*)::int c from sales where source = 'synthetic_seed'")).c > 0);

    await db.exec(script());

    assert.deepEqual(await stock(), before);
    assert.equal((await one("select count(*)::int c from sales where source = 'synthetic_seed'")).c, 0);
    assert.equal((await one("select count(*)::int c from stock_movements where notes like 'SAMPLE synthetic%'")).c, 0);
    assert.equal((await one("select count(*)::int c from sales where source = 'pos'")).c, realSales.c);
    const kept = await one("select count(*)::int c from stock_movements where coalesce(notes, '') not like 'Opening balance after removing%'");
    assert.equal(kept.c, realMovements.c);
    const ledger = await one(`select count(*) filter (where i.quantity_on_hand <> coalesce(x.s, 0) or i.quantity_reserved <> coalesce(x.r, 0) or i.quantity_held <> coalesce(x.h, 0))::int bad
      from pharmacy_inventory i left join (select inventory_id, sum(on_hand_change) s, sum(reserved_change) r, sum(held_change) h from stock_movements group by 1) x on x.inventory_id = i.id`);
    assert.equal(ledger.bad, 0);
    // Each opening balance comes before every real movement of its batch.
    const late = await one(`select count(*)::int c from stock_movements o join stock_movements m on m.inventory_id = o.inventory_id and m.id <> o.id
      where o.notes like 'Opening balance after removing%' and m.created_at <= o.created_at`);
    assert.equal(late.c, 0);
    // Demand history now holds real sales only.
    const sold = await all("select * from pharmacy_daily_demand($1, current_date - 180, current_date - 1)", [KDY]);
    const realKdy = await one("select coalesce(sum(quantity), 0)::int q from sale_items where pharmacy_id = $1 and sold_at < (current_date::timestamp at time zone 'Asia/Colombo')", [KDY]);
    assert.equal(sold.reduce((t, r) => t + r.quantity_sold, 0), realKdy.q);

    const movements = await one("select count(*)::int c from stock_movements");
    await db.exec(script());
    assert.equal((await one("select count(*)::int c from stock_movements")).c, movements.c);
    assert.deepEqual(await stock(), before);
  });
});
