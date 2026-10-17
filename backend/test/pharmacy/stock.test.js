// The service module creates a Supabase client on load; no request is made here.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { stockOf } = require("../../src/pharmacy/analytics/service");

const TODAY = "2026-10-16";
const row = (fields) => ({
  batch_id: fields.batch_id,
  batch_status: "active",
  expiry_date: "2027-06-30",
  quantity_on_hand: 0,
  quantity_reserved: 0,
  quantity_held: 0,
  quantity_available: 0,
  ...fields,
});

test("stock used by the analytics excludes units held by discrepancy reports", () => {
  const stock = stockOf(
    [
      // 300 on hand, 100 held by a report (e.g. a carton found missing after receipt), 20 reserved for a return.
      row({ batch_id: "a", quantity_on_hand: 300, quantity_held: 100, quantity_reserved: 20, quantity_available: 180 }),
      row({ batch_id: "b", quantity_on_hand: 50, quantity_available: 50, expiry_date: "2026-12-31" }),
    ],
    TODAY
  );
  assert.equal(stock.onHandUsable, 250);
  assert.equal(stock.held, 100);
  assert.equal(stock.reserved, 20);
  assert.equal(stock.available, 230);
  assert.deepEqual(
    stock.batches.map((b) => [b.batchId, b.available]),
    [["a", 180], ["b", 50]]
  );
});

test("expired and inactive batches are not usable; held units are still reported", () => {
  const stock = stockOf(
    [
      row({ batch_id: "expired", expiry_date: "2026-10-15", quantity_on_hand: 40, quantity_available: 40 }),
      row({ batch_id: "recalled", batch_status: "recalled", quantity_on_hand: 30, quantity_held: 10, quantity_available: 20 }),
      row({ batch_id: "ok", expiry_date: TODAY, quantity_on_hand: 5, quantity_available: 5 }),
    ],
    TODAY
  );
  assert.equal(stock.onHandUsable, 5);
  assert.equal(stock.held, 10);
  assert.equal(stock.available, 5);
});

test("rows from before the holds migration (no quantity_held) count nothing as held", () => {
  const legacy = row({ batch_id: "a", quantity_on_hand: 12, quantity_available: 12 });
  delete legacy.quantity_held;
  const stock = stockOf([legacy], TODAY);
  assert.equal(stock.onHandUsable, 12);
  assert.equal(stock.held, 0);
});
