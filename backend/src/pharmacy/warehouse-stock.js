// Warehouse stock a pharmacy can order: what pharmacy_dispatch_order() would
// pick for it, with the same rules - the pharmacy's supplying warehouse,
// storage zones, active storage locations, active batches with at least
// MIN_SHELF_DAYS of shelf life left. Whole warehouse packs.
//
// Read live from Component 3's warehouse_stock. The warehouse does not reserve
// stock for submitted orders, so other pharmacies' open orders are not deducted;
// dispatch checks the stock again.

const { supabase, today, addDays, fetchAll } = require("./store");

// pharmacy_dispatch_order(p_min_shelf_days default 30).
const MIN_SHELF_DAYS = 30;

const STOCK_SELECT =
  "id, quantity, batch:batches!inner(medicine_id, status, expiry_date), " +
  "location:storage_locations!inner(is_active, rack:warehouse_racks!inner(zone:warehouse_zones!inner(warehouse_id, zone_type)))";

// Map medicineId -> packs available to order from the warehouse.
async function getWarehouseAvailability(warehouseId, medicineIds = null) {
  const packs = new Map();
  if (!warehouseId) return packs;
  const minExpiry = addDays(today(), MIN_SHELF_DAYS);
  const rows = await fetchAll(() => {
    let query = supabase
      .from("warehouse_stock")
      .select(STOCK_SELECT)
      .eq("batch.status", "active")
      .gte("batch.expiry_date", minExpiry)
      .eq("location.is_active", true)
      .eq("location.rack.zone.warehouse_id", warehouseId)
      .eq("location.rack.zone.zone_type", "storage")
      .order("id");
    if (medicineIds) query = query.in("batch.medicine_id", medicineIds);
    return query;
  });
  for (const row of rows) packs.set(row.batch.medicine_id, (packs.get(row.batch.medicine_id) ?? 0) + row.quantity);
  return packs;
}

// Order lines asking for more than the warehouse has. Lines of the same
// product are added up. names: Map medicineId -> label for messages.
function warehouseShortages(items, packs, names = new Map()) {
  const ordered = new Map();
  for (const item of items) ordered.set(item.medicineId, (ordered.get(item.medicineId) ?? 0) + item.quantity);
  return [...ordered.entries()]
    .map(([medicineId, quantity]) => ({ medicineId, name: names.get(medicineId) ?? "A product", ordered: quantity, available: packs.get(medicineId) ?? 0 }))
    .filter((line) => line.ordered > line.available);
}

module.exports = { MIN_SHELF_DAYS, getWarehouseAvailability, warehouseShortages };
