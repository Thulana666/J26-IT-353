// /api/warehouse/state - structured snapshot of the current warehouse state
// (warehouses > zones > racks > locations > stock) for the PharmaTwin
// digital twin and other components. Read-only.

const express = require("express");
const { rules, validate } = require("../validation");
const { todayISO, TIME_ZONE } = require("../dates");
const { buildHierarchy } = require("../services");

const router = express.Router();

router.get("/", async (req, res) => {
  const { warehouseId } = validate(req.query, { warehouseId: rules.uuid() });
  const today = todayISO();
  res.json({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    today,
    timeZone: TIME_ZONE,
    units: "storage units (quantities and capacities)",
    warehouses: await buildHierarchy({ warehouseId }, today),
  });
});

module.exports = router;
