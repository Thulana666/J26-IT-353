// Database rows (snake_case) -> API objects (camelCase).

const toNumber = (value) => (value == null ? null : Number(value));

function toMedicine(row) {
  return {
    id: row.id,
    name: row.name,
    genericName: row.generic_name,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    dosageForm: row.dosage_form,
    strength: row.strength,
    unit: row.unit,
    storageCondition: row.storage_condition,
    isControlled: row.is_controlled,
    isActive: row.is_active,
  };
}

function toWarehouse(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    location: row.location ? { id: row.location.id, name: row.location.name, type: row.location.location_type } : null,
    nearExpiryDays: row.near_expiry_days,
    criticalExpiryDays: row.critical_expiry_days,
    isActive: row.is_active,
    isSample: row.code?.startsWith("SAMPLE") ?? false,
  };
}

// Row of public.storage_location_overview.
function toLocation(row) {
  return {
    id: row.storage_location_id,
    code: row.location_code,
    level: row.level,
    accessibility: row.accessibility,
    capacityUnits: row.capacity_units,
    occupiedUnits: row.occupied_units,
    availableUnits: row.available_units,
    batchCount: row.batch_count,
    isActive: row.is_active,
    rackId: row.rack_id,
    rackCode: row.rack_code,
    distanceToDispatchM: toNumber(row.distance_to_dispatch_m),
    zoneId: row.zone_id,
    zoneCode: row.zone_code,
    zoneName: row.zone_name,
    zoneType: row.zone_type,
    storageCondition: row.storage_condition,
    isSecure: row.is_secure,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
  };
}

// Row of public.warehouse_stock_overview: one batch at one location.
function toStockItem(row) {
  return {
    stockId: row.stock_id,
    quantity: row.quantity,
    placedAt: row.placed_at,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    batchStatus: row.batch_status,
    batchCreatedAt: row.batch_created_at,
    medicineId: row.medicine_id,
    medicineName: row.medicine_name,
    genericName: row.generic_name,
    strength: row.strength,
    dosageForm: row.dosage_form,
    unit: row.unit,
    storageCondition: row.storage_condition,
    isControlled: row.is_controlled,
    storageLocationId: row.storage_location_id,
    locationCode: row.location_code,
    accessibility: row.accessibility,
    rackId: row.rack_id,
    rackCode: row.rack_code,
    distanceToDispatchM: toNumber(row.distance_to_dispatch_m),
    zoneId: row.zone_id,
    zoneCode: row.zone_code,
    zoneType: row.zone_type,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
  };
}

function toBatch(row) {
  return {
    id: row.id,
    batchNumber: row.batch_number,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    supplier: row.supplier,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    medicine: row.medicine ? toMedicine(row.medicine) : undefined,
  };
}

function toQrCode(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    code: row.code,
    payload: row.payload,
    isActive: row.is_active,
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at,
  };
}

// `locations` maps location id -> toLocation(); `people` maps user id -> name.
function toMovement(row, { locations = new Map(), people = new Map() } = {}) {
  const place = (id) => {
    if (!id) return null;
    const location = locations.get(id);
    return location
      ? { id, code: location.code, zoneCode: location.zoneCode, warehouseCode: location.warehouseCode }
      : { id, code: null };
  };
  return {
    id: row.id,
    movementType: row.movement_type,
    quantity: row.quantity,
    batch: row.batch
      ? {
          id: row.batch_id,
          batchNumber: row.batch.batch_number,
          expiryDate: row.batch.expiry_date,
          medicineName: row.batch.medicine?.name ?? null,
          strength: row.batch.medicine?.strength ?? null,
        }
      : { id: row.batch_id },
    from: place(row.from_location_id),
    to: place(row.to_location_id),
    performedBy: row.performed_by
      ? { id: row.performed_by, name: people.get(row.performed_by) ?? null }
      : null,
    performedVia: row.performed_via,
    fefoCompliant: row.fefo_compliant,
    fefoOverrideReason: row.fefo_override_reason,
    reference: row.reference,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

module.exports = { toMedicine, toWarehouse, toLocation, toStockItem, toBatch, toQrCode, toMovement };
