// /api/warehouse/warehouses - warehouses and their FEFO thresholds.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate, fieldError, toColumns } = require("../validation");
const { requireAdmin } = require("../auth");
const { toWarehouse } = require("../mappers");
const { assertThresholds, DEFAULT_THRESHOLDS } = require("../expiry");

const router = express.Router();
const { supabase } = store;

const COLUMNS = {
  code: "code",
  name: "name",
  address: "address",
  locationId: "location_id",
  nearExpiryDays: "near_expiry_days",
  criticalExpiryDays: "critical_expiry_days",
  isActive: "is_active",
};

function warehouseSchema(creating) {
  return {
    code: rules.string({ required: creating, max: 30 }),
    name: rules.string({ required: creating, max: 200 }),
    address: rules.string({ max: 300, nullable: true }),
    locationId: rules.uuid({ nullable: true }),
    nearExpiryDays: rules.int({ min: 2, max: 3650 }),
    criticalExpiryDays: rules.int({ min: 1, max: 3650 }),
    isActive: rules.bool(),
  };
}

function checkThresholds(thresholds) {
  try {
    assertThresholds(thresholds);
  } catch (error) {
    throw fieldError("nearExpiryDays", error.message);
  }
}

router.get("/", async (_req, res) => {
  res.json({ warehouses: (await store.getWarehouses()).map(toWarehouse) });
});

router.post("/", requireAdmin, async (req, res) => {
  const values = validate(req.body, warehouseSchema(true));
  checkThresholds({ ...DEFAULT_THRESHOLDS, ...values });
  const row = unwrap(
    await supabase.from("warehouses").insert(toColumns(values, COLUMNS)).select(store.WAREHOUSE_SELECT).single()
  );
  res.status(201).json({ warehouse: toWarehouse(row) });
});

router.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, warehouseSchema(false));
  if (Object.keys(values).length === 0) throw new HttpError(400, "Nothing to update");
  const current = toWarehouse(await store.getWarehouse(id));
  checkThresholds({
    nearExpiryDays: values.nearExpiryDays ?? current.nearExpiryDays,
    criticalExpiryDays: values.criticalExpiryDays ?? current.criticalExpiryDays,
  });
  const row = unwrap(
    await supabase.from("warehouses").update(toColumns(values, COLUMNS)).eq("id", id).select(store.WAREHOUSE_SELECT).single()
  );
  res.json({ warehouse: toWarehouse(row) });
});

module.exports = router;
