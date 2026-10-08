const test = require("node:test");
const assert = require("node:assert/strict");
const { rankFefo, buildPickList, checkDispatchCompliance, splitByEligibility } = require("../../src/warehouse/fefo");

const TODAY = "2026-10-07";

function item(overrides) {
  return {
    batchId: overrides.batchNumber,
    batchNumber: "B",
    expiryDate: "2027-01-01",
    manufacturingDate: null,
    batchCreatedAt: "2026-01-01T00:00:00Z",
    batchStatus: "active",
    zoneType: "storage",
    quantity: 10,
    storageLocationId: `loc-${overrides.batchNumber}`,
    locationCode: `L-${overrides.batchNumber}`,
    distanceToDispatchM: 10,
    ...overrides,
  };
}

test("eligible stock is ordered by earliest expiry, not by receipt date (FEFO, not FIFO)", () => {
  const items = [
    // Received first but expires last: FIFO would pick this one.
    item({ batchNumber: "OLDEST-RECEIPT", expiryDate: "2027-11-01", batchCreatedAt: "2026-01-01T00:00:00Z" }),
    item({ batchNumber: "SOONEST", expiryDate: "2026-11-01", batchCreatedAt: "2026-09-01T00:00:00Z" }),
    item({ batchNumber: "MIDDLE", expiryDate: "2027-03-01", batchCreatedAt: "2026-05-01T00:00:00Z" }),
  ];
  assert.deepEqual(rankFefo(items, TODAY).map((i) => i.batchNumber), ["SOONEST", "MIDDLE", "OLDEST-RECEIPT"]);
});

test("same expiry: older manufacturing date, then earlier receipt, then nearer location", () => {
  const items = [
    item({ batchNumber: "C", manufacturingDate: "2025-02-01", batchCreatedAt: "2026-03-01T00:00:00Z" }),
    item({ batchNumber: "A", manufacturingDate: "2025-01-01", batchCreatedAt: "2026-05-01T00:00:00Z" }),
    item({ batchNumber: "B", manufacturingDate: "2025-02-01", batchCreatedAt: "2026-02-01T00:00:00Z" }),
  ];
  assert.deepEqual(rankFefo(items, TODAY).map((i) => i.batchNumber), ["A", "B", "C"]);

  const sameBatch = [
    item({ batchNumber: "X", storageLocationId: "far", locationCode: "FAR", distanceToDispatchM: 40 }),
    item({ batchNumber: "X", storageLocationId: "near", locationCode: "NEAR", distanceToDispatchM: 5 }),
  ];
  assert.deepEqual(rankFefo(sameBatch, TODAY).map((i) => i.locationCode), ["NEAR", "FAR"]);
});

test("expired, non-active, quarantined and empty stock is excluded with a reason", () => {
  const items = [
    item({ batchNumber: "EXPIRED", expiryDate: "2026-10-06" }),
    item({ batchNumber: "TODAY", expiryDate: TODAY }),
    item({ batchNumber: "RECALLED", batchStatus: "recalled", expiryDate: "2026-10-20" }),
    item({ batchNumber: "IN-QUARANTINE", zoneType: "quarantine", expiryDate: "2026-10-20" }),
    item({ batchNumber: "EMPTY", quantity: 0 }),
  ];
  const { eligible, excluded } = splitByEligibility(items, TODAY);
  assert.deepEqual(eligible.map((i) => i.batchNumber), ["TODAY"]);
  assert.deepEqual(
    Object.fromEntries(excluded.map((i) => [i.batchNumber, i.reason])),
    {
      EXPIRED: "Expired",
      RECALLED: "Batch is recalled",
      "IN-QUARANTINE": "Held in a quarantine zone",
      EMPTY: "No stock",
    }
  );
});

test("pick list takes stock across batches in FEFO order", () => {
  const items = [
    item({ batchNumber: "LATE", expiryDate: "2027-06-01", quantity: 100 }),
    item({ batchNumber: "EARLY", expiryDate: "2026-12-01", quantity: 30 }),
    item({ batchNumber: "MID", expiryDate: "2027-02-01", quantity: 25 }),
  ];
  const result = buildPickList(items, 70, TODAY);
  assert.deepEqual(
    result.lines.map((l) => [l.batchNumber, l.pickQuantity]),
    [["EARLY", 30], ["MID", 25], ["LATE", 15]]
  );
  assert.equal(result.allocated, 70);
  assert.equal(result.shortfall, 0);
  assert.equal(result.available, 155);
});

test("pick list reports a shortfall instead of using ineligible stock", () => {
  const items = [
    item({ batchNumber: "OK", quantity: 20 }),
    item({ batchNumber: "EXPIRED", expiryDate: "2026-01-01", quantity: 500 }),
  ];
  const result = buildPickList(items, 50, TODAY);
  assert.deepEqual(result.lines.map((l) => l.batchNumber), ["OK"]);
  assert.equal(result.allocated, 20);
  assert.equal(result.shortfall, 30);
  assert.equal(result.excluded[0].batchNumber, "EXPIRED");
});

test("dispatching a later-expiring batch is flagged as non-compliant", () => {
  const items = [
    item({ batchNumber: "EARLY", expiryDate: "2026-12-01" }),
    item({ batchNumber: "LATE", expiryDate: "2027-06-01" }),
  ];
  const wrong = checkDispatchCompliance(items, "LATE", TODAY);
  assert.equal(wrong.compliant, false);
  assert.equal(wrong.recommended.batchNumber, "EARLY");
  assert.equal(wrong.earliestExpiryDate, "2026-12-01");

  const right = checkDispatchCompliance(items, "EARLY", TODAY);
  assert.equal(right.compliant, true);
  assert.equal(right.recommended, null);
});

test("batches expiring on the same day as the earliest are compliant", () => {
  const items = [
    item({ batchNumber: "A", expiryDate: "2026-12-01", manufacturingDate: "2025-01-01" }),
    item({ batchNumber: "B", expiryDate: "2026-12-01", manufacturingDate: "2025-06-01" }),
  ];
  assert.equal(checkDispatchCompliance(items, "B", TODAY).compliant, true);
});

test("expired stock does not count as an earlier batch", () => {
  const items = [
    item({ batchNumber: "EXPIRED", expiryDate: "2026-09-01" }),
    item({ batchNumber: "NEXT", expiryDate: "2026-12-01" }),
  ];
  assert.equal(checkDispatchCompliance(items, "NEXT", TODAY).compliant, true);
});
