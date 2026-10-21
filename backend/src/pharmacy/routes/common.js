// Helpers shared by the pharmacy routes.

const { supabase, MEDICINE_SELECT } = require("../store");
const { visiblePharmacyIds } = require("../auth");
const { parse, z, int, id } = require("../validation");

// Records a settings/admin change in the audit log (stock changes are
// audited inside the database functions).
async function audit(req, { action, entityType, entityId = null, pharmacyId = null, details = {} }) {
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: req.user.id,
    pharmacy_id: pharmacyId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  });
  if (error) console.error(`[pharmacy] audit log failed: ${error.message}`);
}

// Filters a query to the pharmacies the user may see. Admins working in one
// pharmacy see that pharmacy unless they ask for ?scope=all.
function scopeToVisible(query, req) {
  const ids = visiblePharmacyIds(req);
  const requested = req.query.pharmacyId;
  if (ids === null) {
    if (typeof requested === "string" && requested) return query.eq("pharmacy_id", parse(id, requested));
    const current = req.get("x-pharmacy-id");
    if (req.user.isAdmin && req.query.scope !== "all" && current) return query.eq("pharmacy_id", parse(id, current));
    return query;
  }
  return query.in("pharmacy_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
}

const listQuery = z.object({
  status: z.string().max(60).optional(),
  limit: int(1, 500).optional(),
});

function parseList(req, allowedStatuses) {
  const query = parse(listQuery, req.query);
  const statuses = query.status ? query.status.split(",").filter(Boolean) : [];
  for (const status of statuses) {
    if (!allowedStatuses.includes(status)) {
      parse(z.object({ status: z.enum(allowedStatuses) }), { status });
    }
  }
  return { statuses, limit: query.limit ?? 100 };
}

// Adds held_units (net units of stock each report currently holds, from the
// stock ledger) to discrepancy rows. Before the holds migration the ledger
// has no held_change column; reports then hold nothing.
async function attachHolds(rows) {
  if (rows.length === 0) return rows;
  const { data, error } = await supabase
    .from("stock_movements")
    .select("reference_id, held_change")
    .eq("reference_type", "discrepancy")
    .in("reference_id", rows.map((r) => r.id));
  if (error) {
    if (error.code === "42703" || error.code === "PGRST204") return rows;
    throw error;
  }
  const held = new Map();
  for (const m of data) held.set(m.reference_id, (held.get(m.reference_id) ?? 0) + m.held_change);
  return rows.map((r) => ({ ...r, held_units: held.get(r.id) ?? 0 }));
}

// PostgREST embeds a one-to-one relation as an object, older versions as an array.
const single = (value) => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

const PRODUCT = `medicine:medicines(${MEDICINE_SELECT})`;

const ORDER_SELECT =
  "id, order_number, pharmacy_id, status, notes, created_by, submitted_at, dispatched_at, received_at, cancelled_at, cancel_reason, " +
  `pharmacy:pharmacies(name), items:purchase_order_items(id, quantity_ordered, recommendation_id, notes, ${PRODUCT}), ` +
  "shipment:shipments(id, shipment_number, status)";

const SHIPMENT_SELECT =
  "id, shipment_number, order_id, pharmacy_id, status, dispatched_by, dispatched_at, received_by, received_at, notes, receipt_notes, " +
  "purchase_order:purchase_orders(order_number), pharmacy:pharmacies(name), " +
  "items:shipment_items(id, order_item_id, quantity_shipped, units_per_pack, quantity_received, quantity_damaged, quantity_accepted, " +
  "unit_cost, unit_price, verification_status, scan_count, accepted_at, batch:batches(id, batch_number, manufacturing_date, expiry_date, status), " +
  `${PRODUCT}, order_item:purchase_order_items(quantity_ordered))`;

const DISCREPANCY_SELECT =
  "id, report_number, shipment_id, shipment_item_id, order_id, pharmacy_id, observed_barcode, observed_batch_number, discrepancy_type, " +
  "expected_quantity, actual_quantity, notes, status, resolution_notes, reported_by, reported_at, acknowledged_at, resolved_by, resolved_at, " +
  `shipment:shipments(shipment_number), purchase_order:purchase_orders(order_number), pharmacy:pharmacies(name), batch:batches(batch_number), ${PRODUCT}`;

const SALE_SELECT =
  "id, sale_number, pharmacy_id, source, subtotal, discount_percent, discount_amount, tax_percent, tax_amount, total_amount, payment_method, " +
  "amount_tendered, change_due, payment_reference, customer_ref, served_by, sold_at, " +
  `items:sale_items(id, quantity, unit_price, line_total, fefo_compliant, batch:batches(batch_number, expiry_date), ${PRODUCT})`;

const RETURN_SELECT =
  "id, return_number, pharmacy_id, status, notes, requested_by, requested_at, reviewed_by, reviewed_at, review_notes, received_by, " +
  "received_at, receipt_notes, pharmacy:pharmacies(name), " +
  `items:return_items(id, inventory_id, quantity, reason, notes, restocked_packs, batch:batches(id, batch_number, expiry_date, status), ${PRODUCT})`;

module.exports = {
  audit,
  attachHolds,
  scopeToVisible,
  parseList,
  single,
  PRODUCT,
  ORDER_SELECT,
  SHIPMENT_SELECT,
  DISCREPANCY_SELECT,
  SALE_SELECT,
  RETURN_SELECT,
};
