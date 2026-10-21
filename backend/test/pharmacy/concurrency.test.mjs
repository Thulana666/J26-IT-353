// Concurrency tests on a real PostgreSQL server (embedded-postgres), with
// many connections firing the same operation at once. Runs every migration
// and both seeds first. Skipped when the embedded server cannot start on this
// machine (e.g. an unsupported platform).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const PARALLEL = 8;

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

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

let pg;
let EmbeddedPostgres;
let server;
let pool;
let dataDir;
let skipReason = null;

try {
  ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  ({ default: pg } = await import("pg"));
} catch {
  skipReason = "embedded-postgres / pg not installed";
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const settled = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === "fulfilled").map((r) => r.value);
const rejected = (results) => results.filter((r) => r.status === "rejected").map((r) => r.reason);

let COL;
let staff;

describe("concurrent operations on a real PostgreSQL server", { skip: skipReason ?? false, timeout: 180_000 }, () => {
  before(async () => {
    const port = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pharmacy-pg-"));
    server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "test", port, persistent: false, onLog: () => {} });
    await server.initialise();
    await server.start();
    pool = new pg.Pool({ host: "localhost", port, user: "postgres", password: "test", database: "postgres", max: PARALLEL + 2 });
    await pool.query(SUPABASE_STUBS);
    const dir = path.join(ROOT, "supabase/migrations");
    for (const file of fs.readdirSync(dir).sort()) await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const file of ["sample_warehouse.sql", "sample_pharmacy.sql"]) await pool.query(fs.readFileSync(path.join(ROOT, "supabase/seed", file), "utf8"));
    COL = (await one("select id from pharmacies where code = 'SAMPLE-PH-COL'")).id;
    staff = (await one("insert into auth.users (email) values ('concurrency@test.local') returning id")).id;
  });

  after(async () => {
    await pool?.end();
    await server?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("simultaneous checkouts never oversell a batch", async () => {
    const row = await one(
      `select i.*, (i.quantity_on_hand - i.quantity_reserved) as available from pharmacy_inventory i
       join batches b on b.id = i.batch_id where i.pharmacy_id = $1 and b.batch_number = 'SAMPLE-RX-SAL-C'`,
      [COL]
    );
    const quantity = Math.ceil(row.available / 4); // 8 bills asking for ~2x the stock
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query("select * from pharmacy_checkout($1, $2, gen_random_uuid(), $3::jsonb, 0, 'card', null)", [
          COL, staff, JSON.stringify([{ batchId: row.batch_id, quantity }]),
        ])
      )
    );
    const sold = fulfilled(results).length;
    assert.equal(sold, Math.floor(row.available / quantity));
    for (const error of rejected(results)) assert.match(error.message, /Not enough stock/);
    const after = await one("select quantity_on_hand from pharmacy_inventory where id = $1", [row.id]);
    assert.equal(after.quantity_on_hand, row.quantity_on_hand - sold * quantity);
    assert.ok(after.quantity_on_hand >= 0);
  });

  test("the same checkout request sent in parallel creates one sale", async () => {
    const row = await one(
      `select i.* from pharmacy_inventory i join batches b on b.id = i.batch_id
       where i.pharmacy_id = $1 and b.batch_number = 'SAMPLE-RX-PCM-C'`,
      [COL]
    );
    const requestId = (await one("select gen_random_uuid() id")).id;
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query("select * from pharmacy_checkout($1, $2, $3, $4::jsonb, 0, 'card', null)", [
          COL, staff, requestId, JSON.stringify([{ batchId: row.batch_id, quantity: 3 }]),
        ])
      )
    );
    const saleIds = new Set(fulfilled(results).map((r) => r.rows[0].id));
    assert.equal(saleIds.size, 1);
    assert.equal(rejected(results).length, 0);
    const after = await one("select quantity_on_hand from pharmacy_inventory where id = $1", [row.id]);
    assert.equal(after.quantity_on_hand, row.quantity_on_hand - 3);
  });

  test("simultaneous Confirm Receipt clicks add the shipment's stock once", async () => {
    const shipment = await one("select * from shipments where status = 'in_transit' and pharmacy_id = $1", [COL]);
    const results = await settled(
      Array.from({ length: PARALLEL }, () => pool.query("select pharmacy_confirm_receipt($1, $2, $3) as r", [shipment.id, COL, staff]))
    );
    const outcomes = fulfilled(results).map((r) => r.rows[0].r);
    assert.equal(outcomes.length, PARALLEL);
    assert.equal(outcomes.filter((o) => !o.already_processed).length, 1);
    const items = await one("select count(*)::int c, sum(quantity_shipped * units_per_pack)::int units from shipment_items where shipment_id = $1", [shipment.id]);
    const movements = await one("select count(*)::int c, sum(on_hand_change)::int units from stock_movements where reference_id = $1 and movement_type = 'receipt'", [shipment.id]);
    assert.deepEqual(movements, items);
  });

  test("simultaneous write-offs of a held discrepancy remove the units once", async () => {
    const shipment = await one("select * from shipments where status = 'received' and pharmacy_id = $1 order by received_at desc limit 1", [COL]);
    const item = await one("select * from shipment_items where shipment_id = $1 order by quantity_shipped desc limit 1", [shipment.id]);
    const report = (await one(
      "select pharmacy_report_discrepancy($1, $2, $3, 'missing', $4, $5, 'Carton missing', null, null, null, gen_random_uuid()) as r",
      [shipment.id, COL, staff, item.id, item.quantity_shipped - 1]
    )).r;
    assert.equal(report.held_units, item.units_per_pack);
    await pool.query("select * from pharmacy_update_discrepancy($1, $2, 'resolved', 'Credit note issued')", [report.id, staff]);
    const before = await one("select quantity_on_hand, quantity_held from pharmacy_inventory where pharmacy_id = $1 and batch_id = $2", [COL, item.batch_id]);
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query("select pharmacy_settle_discrepancy_hold($1, $2, $3, 'write_off') as r", [report.id, COL, staff])
      )
    );
    assert.equal(rejected(results).length, 0);
    assert.equal(fulfilled(results).filter((r) => !r.rows[0].r.already_processed).length, 1);
    const after = await one("select quantity_on_hand, quantity_held from pharmacy_inventory where pharmacy_id = $1 and batch_id = $2", [COL, item.batch_id]);
    assert.equal(after.quantity_on_hand, before.quantity_on_hand - item.units_per_pack);
    assert.equal(after.quantity_held, before.quantity_held - item.units_per_pack);
  });

  test("the same discrepancy submission sent in parallel is saved once", async () => {
    const met = (await one("select id from medicines where name = 'Metformin'")).id;
    const order = await one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [COL, staff, JSON.stringify([{ medicineId: met, quantity: 2 }])]);
    const shipment = await one("select * from pharmacy_dispatch_order($1, $2)", [order.id, staff]);
    const item = await one("select id from shipment_items where shipment_id = $1 limit 1", [shipment.id]);
    const requestId = (await one("select gen_random_uuid() id")).id;
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query("select pharmacy_report_discrepancy($1, $2, $3, 'missing', $4, 1, 'One carton missing', null, null, null, $5) as r", [
          shipment.id, COL, staff, item.id, requestId,
        ])
      )
    );
    assert.equal(rejected(results).length, 0);
    assert.equal(new Set(fulfilled(results).map((r) => r.rows[0].r.id)).size, 1);
    assert.equal((await one("select count(*)::int c from shipment_discrepancies where shipment_id = $1", [shipment.id])).c, 1);
  });

  test("simultaneous warehouse acceptance of a return transfers the stock once", async () => {
    const row = await one(
      `select i.* from pharmacy_inventory i join batches b on b.id = i.batch_id
       where i.pharmacy_id = $1 and b.batch_number = 'SAMPLE-RX-MET-C'`,
      [COL]
    );
    const ret = await one("select * from pharmacy_create_return($1, $2, $3::jsonb)", [COL, staff, JSON.stringify([{ inventoryId: row.id, quantity: 5, reason: "overstock" }])]);
    const results = await settled(
      Array.from({ length: PARALLEL }, () => pool.query("select * from pharmacy_receive_return($1, $2)", [ret.id, staff]))
    );
    assert.equal(rejected(results).length, 0);
    const after = await one("select quantity_on_hand, quantity_reserved from pharmacy_inventory where id = $1", [row.id]);
    assert.equal(after.quantity_on_hand, row.quantity_on_hand - 5);
    assert.equal(after.quantity_reserved, row.quantity_reserved);
    assert.equal((await one("select count(*)::int c from stock_movements where reference_id = $1 and movement_type = 'return_dispatch'", [ret.id])).c, 1);
  });

  test("the stock ledger still matches inventory after the concurrent runs", async () => {
    const r = await one(`select count(*) filter (where i.quantity_on_hand <> coalesce(x.s, 0) or i.quantity_reserved <> coalesce(x.r, 0) or i.quantity_held <> coalesce(x.h, 0))::int bad
      from pharmacy_inventory i left join (select inventory_id, sum(on_hand_change) s, sum(reserved_change) r, sum(held_change) h from stock_movements group by 1) x on x.inventory_id = i.id`);
    assert.equal(r.bad, 0);
  });
});
