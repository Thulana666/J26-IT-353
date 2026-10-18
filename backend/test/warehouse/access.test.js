// Role permissions of the warehouse API over HTTP, with a fake Supabase
// client: who may read, operate and configure the warehouse.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const { after, before, describe, test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const supabase = require("../../src/config/supabase");
const { installFakeSupabase, filterValue } = require("../cold-chain/fake-supabase");
const { medicinesRouter, warehouseRouter } = require("../../src/warehouse");
const { assignmentFor } = require("../../src/warehouse/routes/staff");

// token -> profile; the fake getClaims() returns the profile id as subject.
const PROFILES = {
  admin: { id: "u-admin", role: "admin", status: "active" },
  warehouse: { id: "u-wh", role: "warehouse_staff", status: "active" },
  pharmacy: { id: "u-ph", role: "pharmacy_staff", status: "active" },
  user: { id: "u-user", role: "user", status: "active" },
  inactiveWarehouse: { id: "u-off", role: "warehouse_staff", status: "inactive" },
};

supabase.auth.getClaims = async (token) => {
  const profile = PROFILES[token];
  return profile ? { data: { claims: { sub: profile.id } }, error: null } : { data: null, error: new Error("bad token") };
};
installFakeSupabase(supabase, (query) => {
  if (query.table === "profiles") {
    const rows = Object.values(PROFILES).map((p) => ({ ...p, email: `${p.id}@test`, full_name: null }));
    if (!query.single) return { data: rows, error: null };
    const id = filterValue(query, "eq", "id");
    return { data: rows.find((p) => p.id === id) ?? null, error: null };
  }
  // Every other query: an empty result.
  return { data: query.single ? null : [], error: null };
});

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/medicines", medicinesRouter);
  app.use("/api/warehouse", warehouseRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function call(path, { token, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const ORDER = "11111111-1111-4111-8111-111111111111";

describe("warehouse API access by role", () => {
  test("requests without a valid session are rejected", async () => {
    assert.equal((await call("/warehouse/inventory")).status, 401);
    assert.equal((await call("/warehouse/inventory", { token: "forged" })).status, 401);
  });

  test("pharmacy staff, plain users and inactive accounts cannot use warehouse operations", async () => {
    for (const token of ["pharmacy", "user", "inactiveWarehouse"]) {
      for (const [path, method] of [
        ["/warehouse/inventory", "GET"],
        ["/warehouse/orders", "GET"],
        [`/warehouse/orders/${ORDER}/allocate`, "POST"],
        ["/warehouse/movements", "POST"],
      ]) {
        const { status, body } = await call(path, { token, method, body: method === "POST" ? {} : undefined });
        assert.equal(status, 403, `${token} ${method} ${path}`);
        assert.match(body.error, token === "inactiveWarehouse" ? /inactive/ : /role does not allow/);
      }
    }
  });

  test("warehouse staff and admins can use warehouse operations", async () => {
    for (const token of ["warehouse", "admin"]) {
      const { status } = await call("/warehouse/orders", { token });
      assert.equal(status, 200, token);
    }
  });

  test("configuration and stock corrections are admin-only", async () => {
    const zone = { warehouseId: ORDER, code: "Z", name: "Zone" };
    assert.equal((await call("/warehouse/storage/zones", { token: "warehouse", method: "POST", body: zone })).status, 403);
    assert.equal((await call(`/warehouse/warehouses/${ORDER}`, { token: "warehouse", method: "PATCH", body: { name: "x" } })).status, 403);
    assert.equal((await call(`/warehouse/batches/${ORDER}`, { token: "warehouse", method: "PATCH", body: { status: "recalled" } })).status, 403);
    const disposal = {
      batchId: ORDER, movementType: "disposal", quantity: 1, fromLocationId: ORDER, notes: "expired stock",
    };
    const denied = await call("/warehouse/movements", { token: "warehouse", method: "POST", body: disposal });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /Only admins can record a disposal/);
  });

  test("the medicine catalogue is readable by staff but written only by admins", async () => {
    assert.equal((await call("/medicines", { token: "pharmacy" })).status, 200);
    assert.equal((await call("/medicines", { token: "user" })).status, 403);
    assert.equal((await call("/medicines", { token: "pharmacy", method: "POST", body: { name: "X" } })).status, 403);
    assert.equal((await call("/medicines", { token: "warehouse", method: "POST", body: { name: "X" } })).status, 403);
  });

  test("staff access is managed by admins only", async () => {
    for (const token of ["warehouse", "pharmacy", "user"]) {
      assert.equal((await call("/warehouse/staff", { token })).status, 403, token);
    }
    assert.equal((await call("/warehouse/staff", { token: "admin" })).status, 200);
    const self = await call("/warehouse/staff/u-admin", { token: "admin", method: "PATCH", body: { role: "user", status: "active" } });
    assert.equal(self.status, 400); // not a uuid
  });

  test("only pharmacy staff get a pharmacy; warehouse staff need a warehouse", () => {
    const P = "11111111-1111-4111-8111-111111111111";
    const W = "22222222-2222-4222-8222-222222222222";
    assert.deepEqual(assignmentFor({ role: "pharmacy_staff", pharmacyId: P, warehouseId: W }), { pharmacy_id: P, warehouse_id: null });
    assert.deepEqual(assignmentFor({ role: "warehouse_staff", pharmacyId: P, warehouseId: W }), { pharmacy_id: null, warehouse_id: W });
    assert.deepEqual(assignmentFor({ role: "admin", pharmacyId: P, warehouseId: W }), { pharmacy_id: null, warehouse_id: W });
    assert.deepEqual(assignmentFor({ role: "admin", pharmacyId: P }), { pharmacy_id: null, warehouse_id: null });
    assert.deepEqual(assignmentFor({ role: "user", pharmacyId: P, warehouseId: W }), { pharmacy_id: null, warehouse_id: null });
    assert.throws(() => assignmentFor({ role: "pharmacy_staff", warehouseId: W }), (e) => Boolean(e.details.fields.pharmacyId));
    assert.throws(() => assignmentFor({ role: "warehouse_staff", pharmacyId: P }), (e) => Boolean(e.details.fields.warehouseId));
  });

  test("invalid input is rejected before anything is written", async () => {
    const { status, body } = await call(`/warehouse/orders/${ORDER}/allocate`, {
      token: "warehouse", method: "POST", body: { items: [{ orderItemId: "nope", quantity: -1 }] },
    });
    assert.equal(status, 400);
    assert.ok(body.details.fields.orderItemId && body.details.fields.quantity);
    const decline = await call(`/warehouse/orders/${ORDER}/decline`, { token: "warehouse", method: "POST", body: {} });
    assert.equal(decline.status, 400);
  });
});
