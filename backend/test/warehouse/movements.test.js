const test = require("node:test");
const assert = require("node:assert/strict");
const { validateMovementInput } = require("../../src/warehouse/movements");
const { HttpError } = require("../../src/warehouse/errors");

const BATCH = "11111111-1111-4111-8111-111111111111";
const LOC_A = "22222222-2222-4222-8222-222222222222";
const LOC_B = "33333333-3333-4333-8333-333333333333";

// Returns the field errors of a rejected input.
function fieldErrors(body) {
  try {
    validateMovementInput(body);
  } catch (error) {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 400);
    return error.details.fields;
  }
  assert.fail("expected the input to be rejected");
}

test("valid movements are normalised", () => {
  assert.deepEqual(
    validateMovementInput({ batchId: BATCH.toUpperCase(), movementType: "receive", quantity: "40", toLocationId: LOC_A }),
    { batchId: BATCH, movementType: "receive", quantity: 40, toLocationId: LOC_A, performedVia: "manual" }
  );
  const transfer = validateMovementInput({
    batchId: BATCH, movementType: "transfer", quantity: 5, fromLocationId: LOC_A, toLocationId: LOC_B,
    performedVia: "qr_scan", reference: "  move to pick face  ",
  });
  assert.equal(transfer.performedVia, "qr_scan");
  assert.equal(transfer.reference, "move to pick face");
});

test("required fields and types", () => {
  const fields = fieldErrors({ movementType: "teleport", quantity: 0 });
  assert.equal(fields.batchId, "is required");
  assert.match(fields.movementType, /must be one of/);
  assert.match(fields.quantity, /at least 1/);
  assert.match(fieldErrors({ batchId: "x", movementType: "receive", quantity: 1, toLocationId: LOC_A }).batchId, /valid id/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "receive", quantity: 2.5, toLocationId: LOC_A }).quantity, /whole number/);
});

test("each movement type needs the right locations", () => {
  assert.match(fieldErrors({ batchId: BATCH, movementType: "receive", quantity: 1 }).toLocationId, /required/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "receive", quantity: 1, fromLocationId: LOC_A, toLocationId: LOC_B }).fromLocationId, /must be empty/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "dispatch", quantity: 1 }).fromLocationId, /required/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "dispatch", quantity: 1, fromLocationId: LOC_A, toLocationId: LOC_B }).toLocationId, /must be empty/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "transfer", quantity: 1, fromLocationId: LOC_A }).toLocationId, /required/);
});

test("a transfer must change location", () => {
  assert.match(
    fieldErrors({ batchId: BATCH, movementType: "transfer", quantity: 1, fromLocationId: LOC_A, toLocationId: LOC_A }).toLocationId,
    /different/
  );
});

test("adjustments touch exactly one location and need a reason", () => {
  const both = fieldErrors({ batchId: BATCH, movementType: "adjustment", quantity: 1, fromLocationId: LOC_A, toLocationId: LOC_B, notes: "count" });
  assert.match(both.fromLocationId, /either/);
  const neither = fieldErrors({ batchId: BATCH, movementType: "adjustment", quantity: 1, notes: "count" });
  assert.match(neither.fromLocationId, /either/);
  assert.match(fieldErrors({ batchId: BATCH, movementType: "adjustment", quantity: 1, toLocationId: LOC_A }).notes, /reason/);
  assert.ok(validateMovementInput({ batchId: BATCH, movementType: "adjustment", quantity: 1, toLocationId: LOC_A, notes: "Cycle count +1" }));
});

test("disposals need a reason", () => {
  assert.match(fieldErrors({ batchId: BATCH, movementType: "disposal", quantity: 3, fromLocationId: LOC_A }).notes, /reason/);
});

test("FEFO override reasons only apply to dispatches and must be meaningful", () => {
  assert.match(
    fieldErrors({ batchId: BATCH, movementType: "receive", quantity: 1, toLocationId: LOC_A, fefoOverrideReason: "Customer request for long dating" }).fefoOverrideReason,
    /only applies/
  );
  assert.match(
    fieldErrors({ batchId: BATCH, movementType: "dispatch", quantity: 1, fromLocationId: LOC_A, fefoOverrideReason: "because" }).fefoOverrideReason,
    /at least 10/
  );
});

test("clients cannot claim system-generated movements", () => {
  assert.match(
    fieldErrors({ batchId: BATCH, movementType: "receive", quantity: 1, toLocationId: LOC_A, performedVia: "system" }).performedVia,
    /must be one of/
  );
});
