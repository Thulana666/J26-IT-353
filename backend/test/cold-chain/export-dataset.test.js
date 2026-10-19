// Training-data export: planned delivery time at the trip start and CSV output.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const { etaAtStart, toCsv } = require("../../scripts/export-cold-chain-dataset");

const trip = { trip_started_at: "2026-10-18T08:00:00Z", expected_delivery_at: "2026-10-18T12:00:00Z" };
const created = (eta, at = "2026-10-18T07:00:00Z") => ({ action: "cold_chain.monitoring_started", created_at: at, details: { expectedDeliveryAt: eta } });
const updated = (details, at) => ({ action: "cold_chain.monitoring_updated", created_at: at, details });

test("the planned time in effect at the start is used, not a later edit", () => {
  const events = [
    created("2026-10-18T09:00:00Z"),
    updated({ expectedDeliveryAt: "2026-10-18T10:00:00Z" }, "2026-10-18T07:30:00Z"),
    updated({ tempMaxC: 8 }, "2026-10-18T07:45:00Z"),
    updated({ expectedDeliveryAt: "2026-10-18T12:00:00Z" }, "2026-10-18T09:30:00Z"),
  ];
  assert.deepEqual(etaAtStart(trip, events), { value: "2026-10-18T10:00:00Z", source: "audit", changedAfterStart: true });
});

test("an edit after the start that keeps the same time is not a change", () => {
  const events = [created("2026-10-18T12:00:00Z"), updated({ expectedDeliveryAt: "2026-10-18T12:00:00.000Z" }, "2026-10-18T09:00:00Z")];
  assert.deepEqual(etaAtStart(trip, events), { value: "2026-10-18T12:00:00Z", source: "audit", changedAfterStart: false });
});

test("a shipment created again under the same id: only its last creation counts", () => {
  const events = [
    created("2026-10-18T09:00:00Z", "2026-10-17T07:00:00Z"),
    updated({ expectedDeliveryAt: "2026-10-18T09:30:00Z" }, "2026-10-17T08:00:00Z"),
    created("2026-10-18T11:00:00Z", "2026-10-18T07:00:00Z"),
  ];
  assert.deepEqual(etaAtStart(trip, events), { value: "2026-10-18T11:00:00Z", source: "audit", changedAfterStart: false });
});

test("created without a planned time", () => {
  assert.deepEqual(etaAtStart(trip, [created(undefined)]), { value: null, source: "audit", changedAfterStart: false });
});

test("no audit entries: the current value, unless it was edited after the start", () => {
  assert.deepEqual(etaAtStart(trip, []), { value: "2026-10-18T12:00:00Z", source: "current", changedAfterStart: false });
  const later = [updated({ expectedDeliveryAt: "2026-10-18T12:00:00Z" }, "2026-10-18T09:00:00Z")];
  assert.deepEqual(etaAtStart(trip, later), { value: null, source: "unknown", changedAfterStart: true });
});

test("CSV quoting and empty values", () => {
  assert.equal(toCsv(["a", "b", "c"], [{ a: 'x,"y"', b: null, c: 1.5 }]), 'a,b,c\n"x,""y""",,1.5\n');
});
