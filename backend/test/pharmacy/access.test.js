// Role checks, pharmacy visibility and request validation of the pharmacy API.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requireRole, requireWarehouseStaff, visiblePharmacyIds, assertCanSee } = require("../../src/pharmacy/auth");
const { parse, z, int, id, text } = require("../../src/pharmacy/validation");
const { HttpError } = require("../../src/pharmacy/errors");

const PH1 = "11111111-1111-4111-8111-111111111111";
const PH2 = "22222222-2222-4222-8222-222222222222";

const user = (role, extra = {}) => ({
  role,
  isActive: true,
  isAdmin: role === "admin",
  isPharmacyStaff: role === "pharmacy_staff",
  isWarehouseStaff: role === "warehouse_staff",
  pharmacyId: role === "pharmacy_staff" ? PH1 : null,
  ...extra,
});

const passes = (middleware, req) => {
  let called = false;
  middleware(req, {}, () => (called = true));
  return called;
};

test("requireRole lets admins and listed roles through, refuses others and inactive accounts", () => {
  const pharmacyOnly = requireRole("pharmacy_staff");
  assert.equal(passes(pharmacyOnly, { user: user("pharmacy_staff") }), true);
  assert.equal(passes(pharmacyOnly, { user: user("admin") }), true);
  assert.throws(() => passes(pharmacyOnly, { user: user("warehouse_staff") }), (e) => e.status === 403);
  assert.throws(() => passes(pharmacyOnly, { user: user("user") }), (e) => e.status === 403);
  assert.throws(() => passes(requireWarehouseStaff, { user: user("warehouse_staff", { isActive: false, isWarehouseStaff: false }) }), /inactive/);
});

test("pharmacy staff see only their pharmacy; warehouse staff and admins see all", () => {
  assert.deepEqual(visiblePharmacyIds({ user: user("pharmacy_staff") }), [PH1]);
  assert.equal(visiblePharmacyIds({ user: user("warehouse_staff") }), null);
  assert.equal(visiblePharmacyIds({ user: user("admin") }), null);
  assert.deepEqual(visiblePharmacyIds({ user: user("user") }), []);
  assert.doesNotThrow(() => assertCanSee({ user: user("pharmacy_staff") }, PH1));
  assert.throws(() => assertCanSee({ user: user("pharmacy_staff") }, PH2, "Order"), (e) => e instanceof HttpError && e.status === 404 && /Order not found/.test(e.message));
});

test("validation returns 400 with per-field messages, including nested items", () => {
  const schema = z.object({ items: z.array(z.object({ batchId: id, quantity: int(1, 100) })).min(1), note: text(5) });
  assert.deepEqual(parse(schema, { items: [{ batchId: PH1, quantity: "3" }], note: "  ok " }), {
    items: [{ batchId: PH1, quantity: 3 }],
    note: "ok",
  });
  assert.throws(
    () => parse(schema, { items: [{ batchId: "nope", quantity: 0 }], note: "too long" }),
    (e) =>
      e.status === 400 &&
      e.details.fields["items.0.batchId"] === "must be a valid id" &&
      e.details.fields["items.0.quantity"] === "must be at least 1" &&
      /at most 5/.test(e.details.fields.note)
  );
  assert.throws(() => parse(schema, { items: [] }), (e) => e.status === 400 && "items" in e.details.fields);
});
