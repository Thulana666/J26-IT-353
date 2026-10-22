// Supabase access shared by the pharmacy routes (service-role client).

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");
const { TIME_ZONE, today, addDays, daysBetween } = require("./dates");

// PostgREST returns at most 1000 rows per request.
const PAGE_SIZE = 1000;

// Runs a query page by page; buildQuery() must return a fresh, stably ordered query.
async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const data = unwrap(await buildQuery().range(from, from + PAGE_SIZE - 1));
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// Calls a database function and returns its result.
async function rpc(name, params) {
  return unwrap(await supabase.rpc(name, params));
}

const MEDICINE_SELECT =
  "id, name, generic_name, brand_name, manufacturer, strength, dosage_form, unit, dispensing_unit, units_per_pack, " +
  "unit_cost, retail_price, storage_condition, is_controlled, is_active, category:medicine_categories(id, name)";

async function getMedicine(id) {
  const row = unwrap(await supabase.from("medicines").select(MEDICINE_SELECT).eq("id", id).maybeSingle());
  if (!row) throw new HttpError(404, "Product not found");
  return row;
}

async function getMedicines({ activeOnly = true } = {}) {
  let query = supabase.from("medicines").select(MEDICINE_SELECT).order("name").order("strength");
  if (activeOnly) query = query.eq("is_active", true);
  return unwrap(await query);
}

// Display names of users (for "received by", "requested by"...).
async function userNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = unwrap(await supabase.from("profiles").select("id, full_name, email").in("id", unique));
  return new Map(rows.map((row) => [row.id, row.full_name || row.email]));
}

// Inventory rows (with batch and product details) of a pharmacy.
function getInventory(pharmacyId) {
  return fetchAll(() =>
    supabase
      .from("pharmacy_inventory_overview")
      .select("*")
      .eq("pharmacy_id", pharmacyId)
      .order("medicine_name")
      .order("expiry_date")
      .order("inventory_id")
  );
}

// Packs on their way to the pharmacy, in dispensing units, per product:
// shipped but not yet received, plus submitted orders not yet dispatched.
// Warehouse fulfilment statuses of an order the warehouse has accepted but not shipped yet.
const ACCEPTED_FULFILMENT = new Set(["allocated", "picking", "ready"]);

// Stock ordered from the warehouse, in dispensing units per product:
//   incoming: confirmed - shipments in transit, plus submitted orders the
//             warehouse has accepted (a live fulfilment allocated to them),
//   awaiting: submitted orders the warehouse has not accepted yet. These are
//             not counted in the inventory position (they may never ship).
// Without the warehouse fulfilment table, submitted orders count as incoming.
async function getOrderedUnits(pharmacyId) {
  const submittedQuery = (withFulfilment) => () =>
    supabase
      .from("purchase_order_items")
      .select(
        `medicine_id, quantity_ordered, medicine:medicines(units_per_pack), purchase_order:purchase_orders!inner(status${
          withFulfilment ? ", fulfilments:warehouse_order_fulfilments(status)" : ""
        })`
      )
      .eq("pharmacy_id", pharmacyId)
      .eq("purchase_order.status", "submitted")
      .order("id");
  const [inTransit, submitted] = await Promise.all([
    fetchAll(() =>
      supabase
        .from("shipment_items")
        .select("medicine_id, quantity_shipped, units_per_pack, shipment:shipments!inner(status)")
        .eq("pharmacy_id", pharmacyId)
        .eq("shipment.status", "in_transit")
        .order("id")
    ),
    fetchAll(submittedQuery(true)).catch((error) => {
      // Older databases without the warehouse fulfilment module.
      if (["PGRST200", "PGRST205", "42P01"].includes(error.dbCode)) return fetchAll(submittedQuery(false));
      throw error;
    }),
  ]);
  const incoming = new Map();
  const awaiting = new Map();
  const add = (map, medicineId, units) => map.set(medicineId, (map.get(medicineId) ?? 0) + units);
  for (const row of inTransit) add(incoming, row.medicine_id, row.quantity_shipped * row.units_per_pack);
  for (const row of submitted) {
    const units = row.quantity_ordered * (row.medicine?.units_per_pack ?? 1);
    const fulfilments = row.purchase_order?.fulfilments;
    const accepted = fulfilments === undefined || fulfilments.some((f) => ACCEPTED_FULFILMENT.has(f.status));
    add(accepted ? incoming : awaiting, row.medicine_id, units);
  }
  return { incoming, awaiting };
}

async function getIncomingUnits(pharmacyId) {
  return (await getOrderedUnits(pharmacyId)).incoming;
}

// Daily units sold and closing stock per product (see pharmacy_daily_demand()).
async function getDailyDemand(pharmacyId, from, to) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = unwrap(
      await supabase
        .rpc("pharmacy_daily_demand", { p_pharmacy_id: pharmacyId, p_from: from, p_to: to, p_time_zone: TIME_ZONE })
        .range(offset, offset + PAGE_SIZE - 1)
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function getReorderSettings(pharmacyId) {
  const rows = unwrap(await supabase.from("reorder_settings").select("*").eq("pharmacy_id", pharmacyId));
  return new Map(rows.map((row) => [row.medicine_id, row]));
}

module.exports = {
  supabase,
  TIME_ZONE,
  today,
  addDays,
  daysBetween,
  fetchAll,
  rpc,
  MEDICINE_SELECT,
  getMedicine,
  getMedicines,
  userNames,
  getInventory,
  getIncomingUnits,
  getOrderedUnits,
  getDailyDemand,
  getReorderSettings,
};
