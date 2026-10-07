// /api/warehouse/spatial - storage location recommendations (Python service).

const express = require("express");
const { rules, validate, fieldError } = require("../validation");
const { todayISO } = require("../dates");
const { recommendLocation } = require("../services");
const spatialClient = require("../spatial-client");

const router = express.Router();

// POST /api/warehouse/spatial/recommend
// { warehouseId, quantity, batchId } for an existing batch (e.g. re-slotting,
// with excludeLocationId = its current location), or
// { warehouseId, quantity, medicineId, expiryDate } for an incoming batch.
router.post("/recommend", async (req, res) => {
  const input = validate(req.body, {
    warehouseId: rules.uuid({ required: true }),
    quantity: rules.int({ required: true, min: 1, max: 1_000_000 }),
    batchId: rules.uuid(),
    medicineId: rules.uuid(),
    expiryDate: rules.date(),
    batchNumber: rules.string({ max: 60 }),
    excludeLocationId: rules.uuid(),
    limit: rules.int({ min: 1, max: 20, default: 5 }),
  });
  if (!input.batchId && !(input.medicineId && input.expiryDate)) {
    throw fieldError("batchId", "Give an existing batch, or a medicine and an expiry date");
  }
  res.json(await recommendLocation(input, todayISO()));
});

// GET /api/warehouse/spatial/status - is the Python service reachable?
router.get("/status", async (_req, res) => {
  res.json(await spatialClient.status());
});

module.exports = router;
