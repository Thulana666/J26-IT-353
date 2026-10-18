const test = require("node:test");
const assert = require("node:assert/strict");
const { orderStage, matchesLocation, identifyBatchInput, buildLocationPayload } = require("../../src/warehouse/fulfilment");
const qr = require("../../src/warehouse/qr");

const LOCATION = { id: "4a1c2b3d-1111-4222-8333-444455556666", code: "A01-L2-P1" };

test("order stages follow the order, fulfilment and shipment status", () => {
  assert.equal(orderStage({ status: "submitted" }, null), "pending");
  assert.equal(orderStage({ status: "submitted" }, { status: "cancelled" }), "pending");
  assert.equal(orderStage({ status: "submitted" }, { status: "allocated" }), "processing");
  assert.equal(orderStage({ status: "submitted" }, { status: "picking" }), "processing");
  assert.equal(orderStage({ status: "submitted" }, { status: "ready" }), "ready");
  assert.equal(orderStage({ status: "dispatched" }, { status: "dispatched" }, { status: "in_transit" }), "in_transit");
  assert.equal(orderStage({ status: "dispatched" }, null, { status: "received_with_discrepancies" }), "received");
  assert.equal(orderStage({ status: "received" }, null, { status: "received" }), "received");
  assert.equal(orderStage({ status: "cancelled" }, { status: "allocated" }), "cancelled");
});

test("a location is verified by its label or its typed code", () => {
  assert.ok(matchesLocation(buildLocationPayload(LOCATION.id), LOCATION));
  assert.ok(matchesLocation(`  ptwh:loc:${LOCATION.id.toUpperCase()} `, LOCATION));
  assert.ok(matchesLocation("a01-l2-p1", LOCATION));
  assert.ok(matchesLocation(" A01-L2-P1 ", LOCATION));
  assert.ok(!matchesLocation("A01-L2-P2", LOCATION));
  assert.ok(!matchesLocation(buildLocationPayload("4a1c2b3d-1111-4222-8333-444455556667"), LOCATION));
  assert.ok(!matchesLocation("PTWH:LOC:not-an-id", LOCATION));
  assert.ok(!matchesLocation("", LOCATION));
});

test("a batch is identified by its QR label, typed code or typed batch number", () => {
  const code = qr.generateCode();
  assert.deepEqual(identifyBatchInput(qr.buildPayload(code), "SAMPLE-PCM-2409"), { kind: "qr", code });
  assert.deepEqual(identifyBatchInput(qr.formatCode(code).toLowerCase(), "SAMPLE-PCM-2409"), { kind: "qr", code });
  // Batch numbers can look like QR codes once dashes are ignored; the expected batch number wins.
  assert.deepEqual(identifyBatchInput("sample-pcm-2409", "SAMPLE-PCM-2409"), { kind: "batch_number" });
  assert.equal(identifyBatchInput("SAMPLE-PCM-2502", "SAMPLE-PCM-2409").kind, "invalid");
  assert.equal(identifyBatchInput("", "X").reason, "empty");
  assert.equal(identifyBatchInput("PTWH:2:ABC", "X").reason, "format");
  // A location label scanned into the batch field is not a batch.
  assert.equal(identifyBatchInput(buildLocationPayload(LOCATION.id), "X").kind, "invalid");
});
