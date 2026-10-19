// Cold-chain handoff (Component 2) and outbox delivery: success, idempotent
// "already monitored", final rejections, retries on 5xx / network failures.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SECRET_KEY ??= "test-key";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const supabase = require("../../src/config/supabase");
const { installFakeSupabase, filterValue } = require("../cold-chain/fake-supabase");
const { startMonitoring } = require("../../src/warehouse/integrations/cold-chain");
const { deliverEvent } = require("../../src/warehouse/integrations");

const SHIPMENT = "33333333-3333-4333-8333-333333333333";
const NO_WAIT = { delaysMs: [0, 0], baseUrl: "http://cold-chain.test" };

// fetch stub answering with the given responses in order.
function fakeFetch(...answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return { status: answer.status, json: async () => answer.body ?? {} };
  };
  return { impl, calls };
}

describe("cold-chain adapter", () => {
  test("starts monitoring with the user's token and the shipment details", async () => {
    const { impl, calls } = fakeFetch({ status: 201, body: { shipment: { id: SHIPMENT } } });
    const result = await startMonitoring(
      { shipmentId: SHIPMENT, expectedDeliveryAt: "2030-01-01T10:00:00.000Z" },
      { token: "user-token", fetchImpl: impl, ...NO_WAIT }
    );
    assert.equal(result.outcome, "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://cold-chain.test/api/cold-chain/shipments");
    assert.equal(calls[0].init.headers.authorization, "Bearer user-token");
    assert.deepEqual(JSON.parse(calls[0].init.body), { shipmentId: SHIPMENT, expectedDeliveryAt: "2030-01-01T10:00:00.000Z" });
  });

  test("an already monitored shipment counts as delivered (idempotent retry)", async () => {
    const { impl } = fakeFetch({ status: 409, body: { error: "Shipment SH-000001 is already monitored" } });
    const result = await startMonitoring({ shipmentId: SHIPMENT }, { token: "t", fetchImpl: impl, ...NO_WAIT });
    assert.equal(result.outcome, "sent");
    assert.equal(result.alreadyMonitored, true);
  });

  test("4xx answers are final and not retried", async () => {
    for (const status of [400, 403, 404, 409]) {
      const { impl, calls } = fakeFetch({ status, body: { error: "Only shipments in transit can be monitored" } });
      const result = await startMonitoring({ shipmentId: SHIPMENT }, { token: "t", fetchImpl: impl, ...NO_WAIT });
      assert.equal(result.outcome, "rejected", String(status));
      assert.equal(calls.length, 1);
    }
  });

  test("5xx answers and network errors are retried, then reported unavailable", async () => {
    const recovering = fakeFetch({ status: 503 }, new Error("ECONNREFUSED"), { status: 201 });
    const ok = await startMonitoring({ shipmentId: SHIPMENT }, { token: "t", fetchImpl: recovering.impl, ...NO_WAIT });
    assert.equal(ok.outcome, "sent");
    assert.equal(ok.attempts, 3);

    const down = fakeFetch(new Error("ECONNREFUSED"));
    const failed = await startMonitoring({ shipmentId: SHIPMENT }, { token: "t", fetchImpl: down.impl, ...NO_WAIT });
    assert.equal(failed.outcome, "unavailable");
    assert.equal(down.calls.length, 3);
    assert.match(failed.error, /not reachable/);
  });

  test("without a user session nothing is sent", async () => {
    const { impl, calls } = fakeFetch({ status: 201 });
    const result = await startMonitoring({ shipmentId: SHIPMENT }, { fetchImpl: impl, ...NO_WAIT });
    assert.equal(result.outcome, "rejected");
    assert.equal(calls.length, 0);
  });
});

describe("outbox delivery", () => {
  function fakeOutbox(event) {
    const updates = [];
    installFakeSupabase(supabase, (query) => {
      if (query.table !== "warehouse_integration_events") return null;
      if (query.op === "update") {
        updates.push(query.payload);
        // Only pending/failed events may be updated (concurrent delivery guard).
        const guarded = query.filters.some(([m, c, v]) => m === "in" && c === "status" && v.includes(event.status));
        return { data: guarded ? { ...event, ...query.payload } : null, error: null };
      }
      return { data: filterValue(query, "eq", "id") === event.id ? event : null, error: null };
    });
    return updates;
  }
  const event = (status, attempts = 0) => ({
    id: "e-1", target: "cold_chain", event_type: "shipment.dispatched", entity_id: SHIPMENT,
    payload: { shipmentNumber: "SH-000009" }, status, attempts,
  });

  test("a failed handoff is recorded and can be retried until it succeeds", async () => {
    const updates = fakeOutbox(event("pending"));
    const failing = { "cold_chain:shipment.dispatched": async () => ({ outcome: "unavailable", attempts: 3, error: "down" }) };
    const failed = await deliverEvent("e-1", { token: "t", adapters: failing });
    assert.equal(failed.status, "failed");
    assert.equal(updates[0].attempts, 3);
    assert.equal(updates[0].last_error, "down");

    fakeOutbox(event("failed", 3));
    const working = { "cold_chain:shipment.dispatched": async () => ({ outcome: "sent", attempts: 1, httpStatus: 201 }) };
    const sent = await deliverEvent("e-1", { token: "t", adapters: working });
    assert.equal(sent.status, "sent");
    assert.equal(sent.attempts, 4);
  });

  test("delivered or skipped events are never sent again", async () => {
    for (const status of ["sent", "skipped"]) {
      fakeOutbox(event(status));
      let called = false;
      const adapters = { "cold_chain:shipment.dispatched": async () => ((called = true), { outcome: "sent" }) };
      const result = await deliverEvent("e-1", { token: "t", adapters });
      assert.equal(result.status, status);
      assert.equal(called, false);
    }
  });
});
