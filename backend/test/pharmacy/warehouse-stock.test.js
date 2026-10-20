// The module creates a Supabase client on load; no request is made here.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { warehouseShortages } = require("../../src/pharmacy/warehouse-stock");

const packs = new Map([
  ["pcm", 274],
  ["ors", 5],
]);
const names = new Map([
  ["pcm", "Paracetamol 500 mg"],
  ["ors", "Oral Rehydration Salts 20.5 g"],
  ["oxy", "Oxytocin 10 IU/mL"],
]);

test("an order within the warehouse's stock has no shortages", () => {
  assert.deepEqual(warehouseShortages([{ medicineId: "pcm", quantity: 274 }, { medicineId: "ors", quantity: 5 }], packs, names), []);
});

test("more than the warehouse has, or a product it does not have, is a shortage", () => {
  assert.deepEqual(warehouseShortages([{ medicineId: "ors", quantity: 6 }, { medicineId: "oxy", quantity: 1 }, { medicineId: "pcm", quantity: 2 }], packs, names), [
    { medicineId: "ors", name: "Oral Rehydration Salts 20.5 g", ordered: 6, available: 5 },
    { medicineId: "oxy", name: "Oxytocin 10 IU/mL", ordered: 1, available: 0 },
  ]);
});

test("lines of the same product are added up before comparing", () => {
  const shortages = warehouseShortages([{ medicineId: "ors", quantity: 3 }, { medicineId: "ors", quantity: 3 }], packs, names);
  assert.deepEqual(shortages, [{ medicineId: "ors", name: "Oral Rehydration Salts 20.5 g", ordered: 6, available: 5 }]);
});
