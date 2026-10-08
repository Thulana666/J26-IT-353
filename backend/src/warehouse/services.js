// Warehouse operations that combine several queries with the business rules
// in expiry.js, fefo.js and qr.js.

const QRCode = require("qrcode");
const store = require("./store");
const spatialClient = require("./spatial-client");
const { HttpError, fromDbError, unwrap } = require("./errors");
const { classifyExpiry, thresholdsOf, widestThresholds, EXPIRY_STATUSES } = require("./expiry");
const { checkDispatchCompliance, dispatchIneligibility } = require("./fefo");
const { generateCode, buildPayload, formatCode } = require("./qr");
const { toBatch, toMedicine, toMovement, toQrCode, toWarehouse } = require("./mappers");

const { supabase } = store;

const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
const round1 = (value) => Math.round(value * 10) / 10;

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return groups;
}

// Adds `expiry` ({ status, daysToExpiry }) using each item's warehouse thresholds.
function classifyStock(items, warehousesById, today) {
  return items.map((item) => ({
    ...item,
    expiry: classifyExpiry(item.expiryDate, today, thresholdsOf(warehousesById.get(item.warehouseId))),
  }));
}

// Stock that must be moved to quarantine: blocked or expired batches still in storage zones.
const needsQuarantine = (item, today) =>
  item.zoneType === "storage" && (item.batchStatus !== "active" || item.expiryDate < today);

async function warehousesById() {
  return new Map((await store.getWarehouses()).map((w) => [w.id, w]));
}

async function mapMovements(rows) {
  if (rows.length === 0) return [];
  const [locations, people] = await Promise.all([
    store.getLocations(),
    store.getPeopleNames(rows.map((row) => row.performed_by)),
  ]);
  const byId = new Map(locations.map((location) => [location.id, location]));
  return rows.map((row) => toMovement(row, { locations: byId, people }));
}

// ---------------------------------------------------------------------------
// QR codes
// ---------------------------------------------------------------------------

async function withImage(qr) {
  const svg = await QRCode.toString(qr.payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return {
    ...qr,
    displayCode: formatCode(qr.code),
    imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  };
}

async function createQrCode(batchId, userId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    const { data, error } = await supabase
      .from("batch_qr_codes")
      .insert({ batch_id: batchId, code, payload: buildPayload(code), created_by: userId })
      .select()
      .single();
    if (!error) return withImage(toQrCode(data));
    if (error.code !== "23505") throw fromDbError(error);
    if (error.message.includes("one_active_per_batch")) {
      throw new HttpError(409, "This batch already has an active QR code");
    }
    // Otherwise a (very unlikely) code collision: try a new code.
  }
  throw new HttpError(500, "Could not generate a unique QR code");
}

// Deactivates the batch's current code (e.g. damaged label) and issues a new one.
async function rotateQrCode(batchId, userId) {
  const batch = await store.getBatch(batchId);
  if (batch.status === "disposed") throw new HttpError(409, "Disposed batches cannot get a new QR code");
  unwrap(
    await supabase
      .from("batch_qr_codes")
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq("batch_id", batchId)
      .eq("is_active", true)
  );
  return createQrCode(batchId, userId);
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

async function getBatchDetail(batchId, today) {
  const row = await store.getBatch(batchId);
  const [warehouses, medicineStock, qrRows, movementRows, allMovements] = await Promise.all([
    warehousesById(),
    store.getStock({ medicineId: row.medicine_id }),
    supabase.from("batch_qr_codes").select("*").eq("batch_id", batchId).order("created_at", { ascending: false }).then(unwrap),
    supabase
      .from("inventory_movements")
      .select(store.MOVEMENT_SELECT)
      .eq("batch_id", batchId)
      .order("created_at", { ascending: false })
      .limit(50)
      .then(unwrap),
    store.fetchAll(() =>
      supabase.from("inventory_movements").select("movement_type, quantity, from_location_id, to_location_id").eq("batch_id", batchId).order("id")
    ),
  ]);

  const stock = classifyStock(medicineStock.filter((item) => item.batchId === batchId), warehouses, today);
  const warehouseIds = [...new Set(stock.map((item) => item.warehouseId))];
  const thresholds = widestThresholds(warehouseIds.map((id) => thresholdsOf(warehouses.get(id))));

  // FEFO position of this batch in each warehouse that holds it.
  const fefo = warehouseIds.map((warehouseId) => {
    const own = stock.filter((item) => item.warehouseId === warehouseId);
    const ineligibleReason = own.every((item) => dispatchIneligibility(item, today))
      ? dispatchIneligibility(own[0], today)
      : null;
    const compliance = checkDispatchCompliance(
      medicineStock.filter((item) => item.warehouseId === warehouseId),
      batchId,
      today
    );
    return {
      warehouseId,
      warehouseCode: warehouses.get(warehouseId)?.code,
      eligible: !ineligibleReason,
      ineligibleReason,
      isNextToDispatch: !ineligibleReason && compliance.compliant,
      recommended: compliance.recommended,
    };
  });

  const totals = {};
  for (const movement of allMovements) {
    // Adjustments count up (into a location) or down (out of one).
    const key = movement.movement_type === "adjustment"
      ? movement.to_location_id ? "adjustmentIn" : "adjustmentOut"
      : movement.movement_type;
    totals[key] = (totals[key] ?? 0) + movement.quantity;
  }

  const active = qrRows.find((qr) => qr.is_active);
  return {
    batch: toBatch(row),
    expiry: classifyExpiry(row.expiry_date, today, thresholds),
    thresholds,
    totalQuantity: sum(stock, (item) => item.quantity),
    stock,
    requiresQuarantine: stock.some((item) => needsQuarantine(item, today)),
    fefo,
    qr: active ? await withImage(toQrCode(active)) : null,
    qrHistory: qrRows.filter((qr) => !qr.is_active).map(toQrCode),
    movementTotals: totals,
    movements: await mapMovements(movementRows),
  };
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

// FEFO check before a dispatch: dispatching a later-expiring batch while an
// earlier one is available needs an override reason, and is recorded as
// non-compliant.
async function assessDispatch(input, today) {
  const [location, batch] = await Promise.all([store.getLocation(input.fromLocationId), store.getBatch(input.batchId)]);
  const items = await store.getStock({ warehouseId: location.warehouseId, medicineId: batch.medicine_id });
  const result = checkDispatchCompliance(items, input.batchId, today);
  if (!result.compliant && !input.fefoOverrideReason) {
    const { batchNumber, expiryDate, locationCode } = result.recommended;
    throw new HttpError(
      409,
      `FEFO: batch ${batchNumber} (at ${locationCode}) expires earlier, on ${expiryDate}, and should be dispatched first. ` +
        "Dispatch that batch, or give a reason for overriding FEFO.",
      { code: "FEFO_VIOLATION", recommended: result.recommended }
    );
  }
  return {
    fefoCompliant: result.compliant,
    overrideReason: result.compliant ? null : input.fefoOverrideReason,
  };
}

async function recordMovement(input, { user, today }) {
  const dispatch = input.movementType === "dispatch" ? await assessDispatch(input, today) : {};
  const row = await store.callMovementFunction(input, { userId: user.id, today, ...dispatch });
  const full = unwrap(await supabase.from("inventory_movements").select(store.MOVEMENT_SELECT).eq("id", row.id).single());
  return (await mapMovements([full]))[0];
}

// ---------------------------------------------------------------------------
// Warehouse state
// ---------------------------------------------------------------------------

async function getSummary({ warehouseId } = {}, today) {
  const [warehouses, locations, stock] = await Promise.all([
    warehousesById(),
    store.getLocations({ warehouseId }),
    store.getStock({ warehouseId }),
  ]);
  const items = classifyStock(stock, warehouses, today);

  const expiry = Object.fromEntries(
    EXPIRY_STATUSES.map((status) => {
      const matching = items.filter((item) => item.expiry.status === status);
      return [status, {
        batches: new Set(matching.map((item) => `${item.warehouseId}:${item.batchId}`)).size,
        units: sum(matching, (item) => item.quantity),
      }];
    })
  );

  const active = locations.filter((location) => location.isActive);
  const capacityUnits = sum(active, (location) => location.capacityUnits);
  const occupiedUnits = sum(locations, (location) => location.occupiedUnits);

  const byZone = [...groupBy(locations, (location) => location.zoneId).values()].map((zone) => {
    const first = zone[0];
    const capacity = sum(zone.filter((l) => l.isActive), (l) => l.capacityUnits);
    const occupied = sum(zone, (l) => l.occupiedUnits);
    return {
      zoneId: first.zoneId,
      zoneCode: first.zoneCode,
      zoneName: first.zoneName,
      zoneType: first.zoneType,
      storageCondition: first.storageCondition,
      isSecure: first.isSecure,
      warehouseCode: first.warehouseCode,
      locations: zone.length,
      capacityUnits: capacity,
      occupiedUnits: occupied,
      utilizationPct: capacity ? round1((occupied / capacity) * 100) : null,
    };
  });

  const quarantine = items.filter((item) => needsQuarantine(item, today));
  return {
    today,
    warehouses: [...warehouses.values()].filter((w) => !warehouseId || w.id === warehouseId).map(toWarehouse),
    totals: {
      units: sum(items, (item) => item.quantity),
      stockRecords: items.length,
      batches: new Set(items.map((item) => item.batchId)).size,
      medicines: new Set(items.map((item) => item.medicineId)).size,
    },
    expiry,
    capacity: {
      locations: locations.length,
      activeLocations: active.length,
      capacityUnits,
      occupiedUnits,
      availableUnits: sum(active, (location) => Math.max(location.availableUnits, 0)),
      utilizationPct: capacityUnits ? round1((occupiedUnits / capacityUnits) * 100) : null,
      fullLocations: active.filter((location) => location.availableUnits <= 0).length,
      emptyLocations: active.filter((location) => location.occupiedUnits === 0).length,
    },
    byZone,
    quarantineRequired: {
      batches: new Set(quarantine.map((item) => item.batchId)).size,
      units: sum(quarantine, (item) => item.quantity),
    },
  };
}

// Warehouses > zones > racks > locations, each location with its stock.
// This is also the digital-twin snapshot (GET /api/warehouse/state).
async function buildHierarchy({ warehouseId } = {}, today) {
  const warehouseRows = (await store.getWarehouses()).filter((w) => !warehouseId || w.id === warehouseId);
  if (warehouseId && warehouseRows.length === 0) throw new HttpError(404, "Warehouse not found");
  const ids = warehouseRows.map((w) => w.id);

  const [zones, racks, locations, stock] = await Promise.all([
    ids.length ? supabase.from("warehouse_zones").select("*").in("warehouse_id", ids).then(unwrap) : [],
    store.fetchAll(() => supabase.from("warehouse_racks").select("*").order("id")),
    store.getLocations({ warehouseId }),
    store.getStock({ warehouseId }),
  ]);
  const byWarehouse = new Map(warehouseRows.map((w) => [w.id, w]));
  const items = classifyStock(stock, byWarehouse, today);
  const stockByLocation = groupBy(items, (item) => item.storageLocationId);
  const locationsByRack = groupBy(locations, (location) => location.rackId);
  const racksByZone = groupBy(racks, (rack) => rack.zone_id);
  const zonesByWarehouse = groupBy(zones, (zone) => zone.warehouse_id);
  const totalsOf = (list) => {
    const activeList = list.filter((l) => l.isActive);
    const capacityUnits = sum(activeList, (l) => l.capacityUnits);
    const occupiedUnits = sum(list, (l) => l.occupiedUnits);
    return {
      locations: list.length,
      capacityUnits,
      occupiedUnits,
      utilizationPct: capacityUnits ? round1((occupiedUnits / capacityUnits) * 100) : null,
    };
  };
  const byCode = (a, b) => store.naturalCompare(a.code, b.code);

  return warehouseRows.map((warehouse) => {
    const zoneList = (zonesByWarehouse.get(warehouse.id) ?? []).map((zone) => {
      const rackList = (racksByZone.get(zone.id) ?? []).map((rack) => {
        const rackLocations = (locationsByRack.get(rack.id) ?? []).map((location) => ({
          ...location,
          stock: (stockByLocation.get(location.id) ?? []).map((item) => ({
            batchId: item.batchId,
            batchNumber: item.batchNumber,
            batchStatus: item.batchStatus,
            medicineId: item.medicineId,
            medicineName: item.medicineName,
            strength: item.strength,
            quantity: item.quantity,
            expiryDate: item.expiryDate,
            expiry: item.expiry,
          })),
        }));
        return {
          id: rack.id,
          code: rack.code,
          distanceToDispatchM: Number(rack.distance_to_dispatch_m),
          totals: totalsOf(rackLocations),
          locations: rackLocations,
        };
      }).sort(byCode);
      const zoneLocations = rackList.flatMap((rack) => rack.locations);
      return {
        id: zone.id,
        code: zone.code,
        name: zone.name,
        zoneType: zone.zone_type,
        storageCondition: zone.storage_condition,
        minTempC: zone.min_temp_c == null ? null : Number(zone.min_temp_c),
        maxTempC: zone.max_temp_c == null ? null : Number(zone.max_temp_c),
        isSecure: zone.is_secure,
        totals: totalsOf(zoneLocations),
        racks: rackList,
      };
    }).sort(byCode);
    return {
      ...toWarehouse(warehouse),
      totals: totalsOf(zoneList.flatMap((zone) => zone.racks.flatMap((rack) => rack.locations))),
      zones: zoneList,
    };
  });
}

// ---------------------------------------------------------------------------
// Spatial allocation
// ---------------------------------------------------------------------------

// Collects the batch and the warehouse's current state and asks the Python
// service to rank storage locations for `quantity` units.
async function recommendLocation(input, today) {
  const warehouse = await store.getWarehouse(input.warehouseId);
  let batch;
  let medicineRow;
  if (input.batchId) {
    const row = await store.getBatch(input.batchId);
    medicineRow = row.medicine;
    batch = { id: row.id, batchNumber: row.batch_number, expiryDate: row.expiry_date, status: row.status };
  } else {
    medicineRow = await store.getMedicine(input.medicineId);
    batch = { id: null, batchNumber: input.batchNumber ?? null, expiryDate: input.expiryDate, status: "active" };
  }

  const [locations, stock] = await Promise.all([
    store.getLocations({ warehouseId: warehouse.id }),
    store.getStock({ warehouseId: warehouse.id }),
  ]);
  const stockByLocation = groupBy(stock, (item) => item.storageLocationId);
  const racksWithMedicine = new Set(stock.filter((i) => i.medicineId === medicineRow.id).map((i) => i.rackId));

  const payload = {
    today,
    thresholds: thresholdsOf(warehouse),
    batch: {
      batchId: batch.id,
      medicineId: medicineRow.id,
      quantity: input.quantity,
      expiryDate: batch.expiryDate,
      storageCondition: medicineRow.storage_condition,
      isControlled: medicineRow.is_controlled,
      status: batch.status,
    },
    locations: locations
      .filter((location) => location.id !== input.excludeLocationId)
      .map((location) => {
        const held = stockByLocation.get(location.id) ?? [];
        return {
          id: location.id,
          code: location.code,
          zoneCode: location.zoneCode,
          zoneType: location.zoneType,
          rackCode: location.rackCode,
          storageCondition: location.storageCondition,
          isSecure: location.isSecure,
          isActive: location.isActive,
          level: location.level,
          accessibility: location.accessibility,
          distanceToDispatchM: location.distanceToDispatchM,
          capacityUnits: location.capacityUnits,
          occupiedUnits: location.occupiedUnits,
          sameBatchUnits: sum(held.filter((i) => batch.id && i.batchId === batch.id), (i) => i.quantity),
          sameMedicineUnits: sum(held.filter((i) => i.medicineId === medicineRow.id), (i) => i.quantity),
          otherMedicineUnits: sum(held.filter((i) => i.medicineId !== medicineRow.id), (i) => i.quantity),
          sameMedicineInRack: racksWithMedicine.has(location.rackId),
        };
      }),
    limit: input.limit ?? 5,
  };

  const result = await spatialClient.recommend(payload);
  return {
    warehouse: toWarehouse(warehouse),
    medicine: toMedicine(medicineRow),
    batch,
    quantity: input.quantity,
    ...result,
  };
}

module.exports = {
  classifyStock,
  needsQuarantine,
  warehousesById,
  mapMovements,
  withImage,
  createQrCode,
  rotateQrCode,
  getBatchDetail,
  recordMovement,
  getSummary,
  buildHierarchy,
  recommendLocation,
  groupBy,
  sum,
};
