// Supabase queries shared by the warehouse routes (service-role client).

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");
const { toLocation, toStockItem } = require("./mappers");

// PostgREST returns at most 1000 rows per request.
const PAGE_SIZE = 1000;

// Runs a query page by page. buildQuery() must return a fresh, stably
// ordered query each time.
async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const data = unwrap(await buildQuery().range(from, from + PAGE_SIZE - 1));
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

const naturalCompare = new Intl.Collator("en", { numeric: true }).compare;
const byLocationCode = (a, b) =>
  naturalCompare(a.warehouseCode, b.warehouseCode) ||
  naturalCompare(a.zoneCode, b.zoneCode) ||
  naturalCompare(a.code ?? a.locationCode, b.code ?? b.locationCode);

const WAREHOUSE_SELECT =
  "id, code, name, address, near_expiry_days, critical_expiry_days, is_active, location:locations(id, name, location_type)";

const MEDICINE_SELECT =
  "id, name, generic_name, dosage_form, strength, unit, storage_condition, is_controlled, is_active, category:medicine_categories(id, name)";

const BATCH_SELECT =
  `id, batch_number, manufacturing_date, expiry_date, supplier, status, notes, created_at, medicine_id, medicine:medicines(${MEDICINE_SELECT})`;

const MOVEMENT_SELECT =
  "id, batch_id, movement_type, quantity, from_location_id, to_location_id, performed_by, performed_via, " +
  "fefo_compliant, fefo_override_reason, reference, notes, created_at, " +
  "batch:batches(batch_number, expiry_date, medicine:medicines(name, strength))";

async function getWarehouses() {
  return unwrap(await supabase.from("warehouses").select(WAREHOUSE_SELECT).order("code"));
}

async function getWarehouse(id) {
  const row = unwrap(await supabase.from("warehouses").select(WAREHOUSE_SELECT).eq("id", id).maybeSingle());
  if (!row) throw new HttpError(404, "Warehouse not found");
  return row;
}

async function getMedicine(id) {
  const row = unwrap(await supabase.from("medicines").select(MEDICINE_SELECT).eq("id", id).maybeSingle());
  if (!row) throw new HttpError(404, "Medicine not found");
  return row;
}

async function getBatch(id) {
  const row = unwrap(await supabase.from("batches").select(BATCH_SELECT).eq("id", id).maybeSingle());
  if (!row) throw new HttpError(404, "Batch not found");
  return row;
}

async function getLocations({ warehouseId } = {}) {
  const rows = await fetchAll(() => {
    let query = supabase.from("storage_location_overview").select("*").order("storage_location_id");
    if (warehouseId) query = query.eq("warehouse_id", warehouseId);
    return query;
  });
  return rows.map(toLocation).sort(byLocationCode);
}

async function getLocation(id) {
  const row = unwrap(
    await supabase.from("storage_location_overview").select("*").eq("storage_location_id", id).maybeSingle()
  );
  if (!row) throw new HttpError(404, "Storage location not found");
  return toLocation(row);
}

async function getStock({ warehouseId, medicineId, batchId } = {}) {
  const rows = await fetchAll(() => {
    let query = supabase.from("warehouse_stock_overview").select("*").order("stock_id");
    if (warehouseId) query = query.eq("warehouse_id", warehouseId);
    if (medicineId) query = query.eq("medicine_id", medicineId);
    if (batchId) query = query.eq("batch_id", batchId);
    return query;
  });
  return rows.map(toStockItem).sort(byLocationCode);
}

// user id -> display name (full name, else email).
async function getPeopleNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = unwrap(await supabase.from("profiles").select("id, full_name, email").in("id", unique));
  return new Map(rows.map((row) => [row.id, row.full_name || row.email]));
}

// The only way stock changes; see record_inventory_movement() in the migration.
async function callMovementFunction(input, { userId, today, fefoCompliant = null, overrideReason = null, performedVia }) {
  const data = unwrap(
    await supabase.rpc("record_inventory_movement", {
      p_batch_id: input.batchId,
      p_movement_type: input.movementType,
      p_quantity: input.quantity,
      p_from_location_id: input.fromLocationId ?? null,
      p_to_location_id: input.toLocationId ?? null,
      p_performed_by: userId ?? null,
      p_performed_via: performedVia ?? input.performedVia ?? "manual",
      p_fefo_compliant: fefoCompliant,
      p_fefo_override_reason: overrideReason,
      p_reference: input.reference ?? null,
      p_notes: input.notes ?? null,
      p_today: today,
    })
  );
  return Array.isArray(data) ? data[0] : data;
}

module.exports = {
  supabase,
  fetchAll,
  naturalCompare,
  byLocationCode,
  WAREHOUSE_SELECT,
  MEDICINE_SELECT,
  BATCH_SELECT,
  MOVEMENT_SELECT,
  getWarehouses,
  getWarehouse,
  getMedicine,
  getBatch,
  getLocations,
  getLocation,
  getStock,
  getPeopleNames,
  callMovementFunction,
};
