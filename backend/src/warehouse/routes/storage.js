// /api/warehouse/storage - zones, racks and storage locations.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError, toColumns } = require("../validation");
const { requireAdmin } = require("../auth");
const { buildHierarchy } = require("../services");
const { todayISO } = require("../dates");
const { STORAGE_CONDITIONS, ZONE_TYPES, ACCESSIBILITY } = require("../constants");

const router = express.Router();
const { supabase } = store;

// GET /api/warehouse/storage?warehouseId= - full hierarchy with occupancy and contents.
router.get("/", async (req, res) => {
  const { warehouseId } = validate(req.query, { warehouseId: rules.uuid() });
  const today = todayISO();
  res.json({ today, warehouses: await buildHierarchy({ warehouseId }, today) });
});

// GET /api/warehouse/storage/locations - flat list for pickers.
router.get("/locations", async (req, res) => {
  const filters = validate(req.query, {
    warehouseId: rules.uuid(),
    zoneType: rules.oneOf(ZONE_TYPES),
    storageCondition: rules.oneOf(STORAGE_CONDITIONS),
    activeOnly: rules.bool({ default: false }),
    minAvailable: rules.int({ min: 0 }),
  });
  const locations = (await store.getLocations({ warehouseId: filters.warehouseId })).filter(
    (location) =>
      (!filters.zoneType || location.zoneType === filters.zoneType) &&
      (!filters.storageCondition || location.storageCondition === filters.storageCondition) &&
      (!filters.activeOnly || location.isActive) &&
      (filters.minAvailable === undefined || location.availableUnits >= filters.minAvailable)
  );
  res.json({ locations });
});

router.post("/zones", requireAdmin, async (req, res) => {
  const values = validate(req.body, {
    warehouseId: rules.uuid({ required: true }),
    code: rules.string({ required: true, max: 20 }),
    name: rules.string({ required: true, max: 120 }),
    zoneType: rules.oneOf(ZONE_TYPES, { default: "storage" }),
    storageCondition: rules.oneOf(STORAGE_CONDITIONS, { default: "ambient" }),
    minTempC: rules.number({ min: -80, max: 60 }),
    maxTempC: rules.number({ min: -80, max: 60 }),
    isSecure: rules.bool({ default: false }),
  });
  if (values.minTempC !== undefined && values.maxTempC !== undefined && values.minTempC > values.maxTempC) {
    throw fieldError("maxTempC", "must be at least the minimum temperature");
  }
  const row = unwrap(
    await supabase
      .from("warehouse_zones")
      .insert(toColumns(values, {
        warehouseId: "warehouse_id", code: "code", name: "name", zoneType: "zone_type",
        storageCondition: "storage_condition", minTempC: "min_temp_c", maxTempC: "max_temp_c", isSecure: "is_secure",
      }))
      .select()
      .single()
  );
  res.status(201).json({ zone: row });
});

router.post("/racks", requireAdmin, async (req, res) => {
  const values = validate(req.body, {
    zoneId: rules.uuid({ required: true }),
    code: rules.string({ required: true, max: 20 }),
    distanceToDispatchM: rules.number({ min: 0, max: 10000, default: 0 }),
  });
  const row = unwrap(
    await supabase
      .from("warehouse_racks")
      .insert(toColumns(values, { zoneId: "zone_id", code: "code", distanceToDispatchM: "distance_to_dispatch_m" }))
      .select()
      .single()
  );
  res.status(201).json({ rack: row });
});

const LOCATION_COLUMNS = {
  rackId: "rack_id",
  code: "code",
  level: "level",
  capacityUnits: "capacity_units",
  accessibility: "accessibility",
  isActive: "is_active",
};

router.post("/locations", requireAdmin, async (req, res) => {
  const values = validate(req.body, {
    rackId: rules.uuid({ required: true }),
    code: rules.string({ required: true, max: 30 }),
    level: rules.int({ min: 1, max: 20, default: 1 }),
    capacityUnits: rules.int({ required: true, min: 1, max: 1_000_000 }),
    accessibility: rules.oneOf(ACCESSIBILITY, { default: "medium" }),
  });
  const row = unwrap(
    await supabase.from("storage_locations").insert(toColumns(values, LOCATION_COLUMNS)).select("id").single()
  );
  res.status(201).json({ location: await store.getLocation(row.id) });
});

router.patch("/locations/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, {
    level: rules.int({ min: 1, max: 20 }),
    capacityUnits: rules.int({ min: 1, max: 1_000_000 }),
    accessibility: rules.oneOf(ACCESSIBILITY),
    isActive: rules.bool(),
  });
  if (Object.keys(values).length === 0) throw new HttpError(400, "Nothing to update");
  const current = await store.getLocation(id);
  if (values.capacityUnits !== undefined && values.capacityUnits < current.occupiedUnits) {
    throw new HttpError(409, `Location ${current.code} holds ${current.occupiedUnits} unit(s); capacity cannot be lower`);
  }
  unwrap(await supabase.from("storage_locations").update(toColumns(values, LOCATION_COLUMNS)).eq("id", id));
  res.json({ location: await store.getLocation(id) });
});

module.exports = router;
