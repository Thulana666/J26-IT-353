// Delivery of the integration outbox (warehouse_integration_events).
//
// Events are written by the database in the same transaction as the work they
// describe (e.g. warehouse_dispatch_fulfilment() queues "shipment.dispatched"
// for Component 2), so nothing is lost if the other component is down. The
// backend delivers them right after the request that created them and on
// "Retry"; each attempt is recorded (attempts, last error, response).
// Delivered or skipped events are never sent again.

const supabase = require("../../config/supabase");
const { HttpError, unwrap } = require("../errors");
const coldChain = require("./cold-chain");

const ADAPTERS = {
  "cold_chain:shipment.dispatched": (event, options) =>
    coldChain.startMonitoring(
      { shipmentId: event.entity_id, expectedDeliveryAt: event.payload?.expectedDeliveryAt ?? null },
      options
    ),
};

function toEvent(row) {
  return {
    id: row.id,
    target: row.target,
    eventType: row.event_type,
    entityId: row.entity_id,
    shipmentNumber: row.shipment?.shipment_number ?? row.payload?.shipmentNumber ?? null,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

// Delivers one event (pending or failed) and records the outcome.
// `adapters` can be replaced in tests.
async function deliverEvent(eventId, { token, adapters = ADAPTERS, adapterOptions = {} } = {}) {
  const event = unwrap(await supabase.from("warehouse_integration_events").select("*").eq("id", eventId).maybeSingle());
  if (!event) throw new HttpError(404, "Integration event not found");
  if (event.status === "sent" || event.status === "skipped") return toEvent(event);

  const adapter = adapters[`${event.target}:${event.event_type}`];
  if (!adapter) throw new HttpError(500, `No adapter for ${event.target} ${event.event_type}`);

  const result = await adapter(event, { token, ...adapterOptions });
  const delivered = result.outcome === "sent";
  const row = unwrap(
    await supabase
      .from("warehouse_integration_events")
      .update({
        status: delivered ? "sent" : "failed",
        attempts: event.attempts + (result.attempts ?? 1),
        last_attempt_at: new Date().toISOString(),
        completed_at: delivered ? new Date().toISOString() : null,
        last_error: delivered ? null : result.error ?? "Delivery failed",
        response: { outcome: result.outcome, httpStatus: result.httpStatus ?? null, alreadyMonitored: result.alreadyMonitored ?? false },
      })
      .eq("id", event.id)
      // Never overwrite an event another request delivered meanwhile.
      .in("status", ["pending", "failed"])
      .select()
      .maybeSingle()
  );
  return toEvent(row ?? event);
}

// Delivers the pending events of one entity (e.g. a shipment just dispatched).
// Failures are recorded, not thrown: the work itself already succeeded.
async function deliverPendingFor(entityId, { token } = {}) {
  const rows = unwrap(
    await supabase.from("warehouse_integration_events").select("id").eq("entity_id", entityId).eq("status", "pending")
  );
  const results = [];
  for (const row of rows) {
    try {
      results.push(await deliverEvent(row.id, { token }));
    } catch (error) {
      console.error(`[warehouse] integration event ${row.id}: ${error.message}`);
    }
  }
  return results;
}

module.exports = { ADAPTERS, toEvent, deliverEvent, deliverPendingFor };
