// /api/warehouse/storage - zones, racks and storage locations.

const express = require("express");
const QRCode = require("qrcode");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError, toColumns } = require("../validation");
const { requireAdmin } = require("../auth");
const { buildHierarchy } = require("../services");
const { todayISO } = require("../dates");
const { STORAGE_CONDITIONS, ZONE_TYPES, ACCESSIBILITY } = require("../constants");
const { buildLocationPayload } = require("../fulfilment");

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

// PATCH /api/warehouse/storage/zones/:id - name, temperature range, secure flag.
// Zone type and storage condition are fixed once stock may be stored there.
router.patch("/zones/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, {
    name: rules.string({ max: 120 }),
    minTempC: rules.number({ min: -80, max: 60, nullable: true }),
    maxTempC: rules.number({ min: -80, max: 60, nullable: true }),
    isSecure: rules.bool(),
  });
  if (Object.keys(values).length === 0) throw new HttpError(400, "Nothing to update");
  const current = unwrap(await supabase.from("warehouse_zones").select("*").eq("id", id).maybeSingle());
  if (!current) throw new HttpError(404, "Zone not found");
  const min = values.minTempC !== undefined ? values.minTempC : current.min_temp_c;
  const max = values.maxTempC !== undefined ? values.maxTempC : current.max_temp_c;
  if (min != null && max != null && Number(min) > Number(max)) throw fieldError("maxTempC", "must be at least the minimum temperature");
  if (values.isSecure === false && current.is_secure) {
    const controlled = unwrap(
      await supabase.from("warehouse_stock_overview").select("stock_id").eq("zone_id", id).eq("is_controlled", true).limit(1)
    );
    if (controlled.length) throw new HttpError(409, "This zone holds controlled medicines; move them before making it non-secure");
  }
  const row = unwrap(
    await supabase
      .from("warehouse_zones")
      .update(toColumns(values, { name: "name", minTempC: "min_temp_c", maxTempC: "max_temp_c", isSecure: "is_secure" }))
      .eq("id", id)
      .select()
      .single()
  );
  res.json({ zone: row });
});

router.patch("/racks/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, {
    code: rules.string({ max: 20 }),
    distanceToDispatchM: rules.number({ min: 0, max: 10000 }),
  });
  if (Object.keys(values).length === 0) throw new HttpError(400, "Nothing to update");
  const row = unwrap(
    await supabase
      .from("warehouse_racks")
      .update(toColumns(values, { code: "code", distanceToDispatchM: "distance_to_dispatch_m" }))
      .eq("id", id)
      .select()
      .maybeSingle()
  );
  if (!row) throw new HttpError(404, "Rack not found");
  res.json({ rack: row });
});

// GET /api/warehouse/storage/locations/:id/label - QR label for a shelf
// location ("PTWH:LOC:<id>"), scanned to verify picks and put-aways.
router.get("/locations/:id/label", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const location = await store.getLocation(id);
  const payload = buildLocationPayload(location.id);
  const svg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  res.json({
    location,
    payload,
    imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  });
});

module.exports = router;
