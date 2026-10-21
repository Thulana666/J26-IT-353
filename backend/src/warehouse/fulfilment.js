// Pure rules for fulfilling pharmacy orders (no database access).
//
// Stages shown to warehouse staff, derived from Component 4's order/shipment
// status and Component 3's fulfilment status:
//   pending      submitted, not allocated yet
//   processing   stock reserved (allocated) or being picked
//   ready        every pick verified at the shelf; can be dispatched
//   in_transit   dispatched; shipment on its way
//   received     the pharmacy confirmed receipt (with or without discrepancies)
//   cancelled    cancelled by the pharmacy or declined by the warehouse

const { PAYLOAD_PREFIX, parseQrInput } = require("./qr");

const ORDER_STAGES = ["pending", "processing", "ready", "in_transit", "received", "cancelled"];

function orderStage(order, fulfilment, shipment) {
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "received") return "received";
  if (order.status === "dispatched") {
    return shipment && shipment.status !== "in_transit" ? "received" : "in_transit";
  }
  if (!fulfilment || fulfilment.status === "cancelled") return "pending";
  return fulfilment.status === "ready" ? "ready" : "processing";
}

// Location labels: "PTWH:LOC:<storage location id>" (an id, nothing secret).
const LOCATION_PREFIX = "PTWH:LOC:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildLocationPayload(locationId) {
  return LOCATION_PREFIX + locationId;
}

const normalizeCode = (text) => text.trim().toUpperCase().replace(/\s+/g, "");

// Does a scanned location label or typed location code match `location`
// ({ id, code })?
function matchesLocation(input, location) {
  if (typeof input !== "string" || !input.trim()) return false;
  const text = input.trim();
  if (text.toUpperCase().startsWith(LOCATION_PREFIX)) {
    const id = text.slice(LOCATION_PREFIX.length);
    return UUID_RE.test(id) && id.toLowerCase() === location.id.toLowerCase();
  }
  return normalizeCode(text) === normalizeCode(location.code);
}

// How the batch was identified at the shelf:
//   { kind: "qr", code }            a batch QR payload or typed QR code (look it up)
//   { kind: "batch_number" }        the typed batch number of the expected batch
//   { kind: "invalid", reason, message }
// A typed batch number is checked first, because batch numbers can look like
// QR codes once dashes are ignored.
function identifyBatchInput(input, expectedBatchNumber) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return { kind: "invalid", reason: "empty", message: "Scan the batch label or type its batch number" };
  if (text.toUpperCase().startsWith(PAYLOAD_PREFIX.split(":")[0] + ":")) {
    const parsed = parseQrInput(text);
    return parsed.ok ? { kind: "qr", code: parsed.code } : { kind: "invalid", reason: parsed.reason, message: parsed.message };
  }
  if (expectedBatchNumber && normalizeCode(text) === normalizeCode(expectedBatchNumber)) {
    return { kind: "batch_number" };
  }
  const parsed = parseQrInput(text);
  if (parsed.ok) return { kind: "qr", code: parsed.code };
  return { kind: "invalid", reason: "batch_mismatch", message: "This is not the batch label or batch number of this pick" };
}

module.exports = {
  ORDER_STAGES,
  orderStage,
  LOCATION_PREFIX,
  buildLocationPayload,
  matchesLocation,
  identifyBatchInput,
};
