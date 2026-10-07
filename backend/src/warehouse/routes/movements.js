// /api/warehouse/movements - movement history and recording movements.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate } = require("../validation");
const { requireActive } = require("../auth");
const { todayISO } = require("../dates");
const { MOVEMENT_TYPES, ADMIN_ONLY_MOVEMENTS, validateMovementInput } = require("../movements");
const { mapMovements, recordMovement } = require("../services");

const router = express.Router();
const { supabase } = store;

// GET /api/warehouse/movements?batchId=&movementType=&warehouseId=&page=&pageSize=  (newest first)
router.get("/", async (req, res) => {
  const filters = validate(req.query, {
    batchId: rules.uuid(),
    movementType: rules.oneOf(MOVEMENT_TYPES),
    warehouseId: rules.uuid(),
    page: rules.int({ min: 1, default: 1 }),
    pageSize: rules.int({ min: 1, max: 100, default: 25 }),
  });
  let query = supabase
    .from("inventory_movement_overview")
    .select(store.MOVEMENT_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id");
  if (filters.batchId) query = query.eq("batch_id", filters.batchId);
  if (filters.movementType) query = query.eq("movement_type", filters.movementType);
  if (filters.warehouseId) query = query.eq("warehouse_id", filters.warehouseId);

  const from = (filters.page - 1) * filters.pageSize;
  const { data, error, count } = await query.range(from, from + filters.pageSize - 1);
  // Asking for a page past the end is not an error.
  if (error && error.code !== "PGRST103") unwrap({ error });
  res.json({
    movements: await mapMovements(data ?? []),
    page: filters.page,
    pageSize: filters.pageSize,
    total: count ?? 0,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / filters.pageSize)),
  });
});

// POST /api/warehouse/movements - receive, transfer, dispatch (FEFO-checked),
// adjustment or disposal (admins).
router.post("/", requireActive, async (req, res) => {
  const input = validateMovementInput(req.body);
  if (ADMIN_ONLY_MOVEMENTS.includes(input.movementType) && !req.user.isAdmin) {
    throw new HttpError(403, `Only admins can record a ${input.movementType}`);
  }
  const movement = await recordMovement(input, { user: req.user, today: todayISO() });
  res.status(201).json({ movement });
});

module.exports = router;
