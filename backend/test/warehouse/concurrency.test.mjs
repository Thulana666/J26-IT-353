// Concurrency tests for Component 3 on a real PostgreSQL server
// (embedded-postgres), with several connections firing at once: competing
// allocations never over-reserve, one order is allocated and dispatched once,
// and a repeated movement request moves stock once. Skipped when the embedded
// server cannot start on this machine.

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
let skipReason = null;
try {
  ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  ({ default: pg } = await import("pg"));
} catch {
  skipReason = "embedded-postgres / pg not installed";
}

let server;
let pool;
let dataDir;
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const settled = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === "fulfilled").map((r) => r.value);
const rejected = (results) => results.filter((r) => r.status === "rejected").map((r) => r.reason);

let COL, staff, MED, BATCH, LOCATION;

const newOrder = async (quantity) =>
  (await one("select * from pharmacy_create_order($1, $2, $3::jsonb)", [COL, staff, JSON.stringify([{ medicineId: MED, quantity }])])).id;

describe("concurrent warehouse operations on a real PostgreSQL server", { skip: skipReason ?? false, timeout: 180_000 }, () => {
  before(async () => {
    const port = await freePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "warehouse-pg-"));
    server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "test", port, persistent: false, onLog: () => {} });
    await server.initialise();
    await server.start();
    pool = new pg.Pool({ host: "localhost", port, user: "postgres", password: "test", database: "postgres", max: PARALLEL + 2 });
    await pool.query(SUPABASE_STUBS);
    const dir = path.join(ROOT, "supabase/migrations");
    for (const file of fs.readdirSync(dir).sort()) await pool.query(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const file of ["sample_warehouse.sql", "sample_pharmacy.sql"]) await pool.query(fs.readFileSync(path.join(ROOT, "supabase/seed", file), "utf8"));
    COL = (await one("select id from pharmacies where code = 'SAMPLE-PH-COL'")).id;
    staff = (await one("insert into auth.users (email) values ('wh-concurrency@test.local') returning id")).id;

    // 50 packs of one batch in one location.
    MED = (await one("insert into medicines (name, strength) values ('TEST Loratadine', '10 mg') returning id")).id;
    const zone = (await one("select z.id from warehouse_zones z join warehouses w on w.id = z.warehouse_id where w.code = 'SAMPLE-CMB' and z.code = 'A'")).id;
    const rack = (await one("insert into warehouse_racks (zone_id, code) values ($1, 'CC1') returning id", [zone])).id;
    LOCATION = (await one("insert into storage_locations (rack_id, code, capacity_units) values ($1, 'CC-1', 200) returning id", [rack])).id;
    BATCH = (await one("insert into batches (medicine_id, batch_number, expiry_date) values ($1, 'CC-B1', current_date + 200) returning id", [MED])).id;
    await one("select * from record_inventory_movement($1, 'receive', 50, null, $2)", [BATCH, LOCATION]);
  });

  after(async () => {
    await pool?.end();
    await server?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("competing allocations never reserve more than the stock", async () => {
    // 8 orders of 15 packs for 50 packs: exactly 3 can be allocated.
    const orders = await Promise.all(Array.from({ length: PARALLEL }, () => newOrder(15)));
    const results = await settled(orders.map((order) => pool.query("select * from warehouse_allocate_order($1, $2)", [order, staff])));
    assert.equal(fulfilled(results).length, 3);
    for (const error of rejected(results)) assert.match(error.message, /Not enough unreserved stock/);
    const reserved = await one("select warehouse_reserved_quantity($1, $2) q", [BATCH, LOCATION]);
    assert.equal(reserved.q, 45);
    // Release them for the next tests.
    for (const row of fulfilled(results)) {
      await pool.query("select * from warehouse_cancel_fulfilment($1, $2, 'test')", [row.rows[0].id, staff]);
    }
  });

  test("the same order allocated and dispatched in parallel ships once", async () => {
    const order = await newOrder(10);
    const allocations = await settled(Array.from({ length: PARALLEL }, () => pool.query("select * from warehouse_allocate_order($1, $2)", [order, staff])));
    const ids = new Set(fulfilled(allocations).map((r) => r.rows[0].id));
    assert.equal(rejected(allocations).length, 0);
    assert.equal(ids.size, 1);
    const [fulfilmentId] = ids;
    const pick = await one("select * from warehouse_order_picks where fulfilment_id = $1", [fulfilmentId]);
    await pool.query("select * from warehouse_confirm_pick($1, $2, $3, $4)", [pick.id, staff, BATCH, LOCATION]);

    const before = await one("select quantity from warehouse_stock where batch_id = $1", [BATCH]);
    const dispatches = await settled(Array.from({ length: PARALLEL }, () => pool.query("select * from warehouse_dispatch_fulfilment($1, $2)", [fulfilmentId, staff])));
    assert.equal(rejected(dispatches).length, 0);
    assert.equal(new Set(fulfilled(dispatches).map((r) => r.rows[0].id)).size, 1);
    const after = await one("select quantity from warehouse_stock where batch_id = $1", [BATCH]);
    assert.equal(after.quantity, before.quantity - 10);
    assert.equal((await one("select count(*)::int c from shipments where order_id = $1", [order])).c, 1);
    assert.equal((await one("select count(*)::int c from inventory_movements where reference = (select shipment_number from shipments where order_id = $1)", [order])).c, 1);
  });

  test("a movement request sent in parallel moves stock once", async () => {
    const requestId = (await one("select gen_random_uuid() id")).id;
    const before = await one("select quantity from warehouse_stock where batch_id = $1", [BATCH]);
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query(
          "select * from record_inventory_movement($1, 'dispatch', 2, $2, null, $3, 'manual', true, null, null, null, current_date, null, $4)",
          [BATCH, LOCATION, staff, requestId]
        )
      )
    );
    assert.equal(rejected(results).length, 0);
    assert.equal(new Set(fulfilled(results).map((r) => r.rows[0].id)).size, 1);
    const after = await one("select quantity from warehouse_stock where batch_id = $1", [BATCH]);
    assert.equal(after.quantity, before.quantity - 2);
  });

  test("dispatches and transfers racing for the last packs never go negative", async () => {
    const stock = await one("select quantity from warehouse_stock where batch_id = $1", [BATCH]);
    const results = await settled(
      Array.from({ length: PARALLEL }, () =>
        pool.query("select * from record_inventory_movement($1, 'dispatch', 6, $2, null, $3, 'manual', true)", [BATCH, LOCATION, staff])
      )
    );
    const done = fulfilled(results).length;
    assert.equal(done, Math.min(PARALLEL, Math.floor(stock.quantity / 6)));
    for (const error of rejected(results)) assert.match(error.message, /Not enough stock/);
    const after = await one("select coalesce(sum(quantity), 0)::int q from warehouse_stock where batch_id = $1", [BATCH]);
    assert.equal(after.q, stock.quantity - done * 6);
  });
});
