// /api/warehouse/fefo - expiry alerts, FEFO pick lists, FEFO dispatch and compliance.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate } = require("../validation");
const { requireActive } = require("../auth");
const { todayISO } = require("../dates");
const { classifyExpiry, thresholdsOf } = require("../expiry");
const { buildPickList } = require("../fefo");
const { toMedicine, toWarehouse } = require("../mappers");
const { classifyStock, groupBy, mapMovements, needsQuarantine, sum, warehousesById } = require("../services");

const router = express.Router();
const { supabase } = store;

function recommendedAction(batch) {
  const { status } = batch.expiry;
  if (status === "expired") {
    return batch.requiresQuarantine ? "Expired: move to quarantine, then dispose" : "Expired: dispose";
  }
  if (batch.batchStatus !== "active") {
    return batch.requiresQuarantine
      ? `Batch is ${batch.batchStatus}: move it to a quarantine zone`
      : `Batch is ${batch.batchStatus}: held in quarantine`;
  }
  if (status === "critical") return "Dispatch first (FEFO); if it cannot be used in time, quarantine it for return or disposal";
  if (status === "near_expiry") return "Prioritise for dispatch";
  return null;
}

// GET /api/warehouse/fefo/alerts?warehouseId=
// Batches that are expired, critical or near expiry, and stock that must be
// moved to quarantine. Thresholds come from each warehouse.
router.get("/alerts", async (req, res) => {
  const { warehouseId } = validate(req.query, { warehouseId: rules.uuid() });
  const today = todayISO();
  const [warehouses, stock] = await Promise.all([warehousesById(), store.getStock({ warehouseId })]);
  const items = classifyStock(stock, warehouses, today);

  const batches = [...groupBy(items, (item) => `${item.warehouseId}:${item.batchId}`).values()].map((list) => {
    const first = list[0];
    const batch = {
      batchId: first.batchId,
      batchNumber: first.batchNumber,
      batchStatus: first.batchStatus,
      medicineId: first.medicineId,
      medicineName: first.medicineName,
      strength: first.strength,
      expiryDate: first.expiryDate,
      expiry: first.expiry,
      warehouseId: first.warehouseId,
      warehouseCode: first.warehouseCode,
      quantity: sum(list, (item) => item.quantity),
      locations: list.map((item) => ({
        id: item.storageLocationId,
        code: item.locationCode,
        zoneCode: item.zoneCode,
        zoneType: item.zoneType,
        quantity: item.quantity,
      })),
      requiresQuarantine: list.some((item) => needsQuarantine(item, today)),
    };
    return { ...batch, action: recommendedAction(batch) };
  });
  const byExpiry = (a, b) => a.expiryDate.localeCompare(b.expiryDate) || store.naturalCompare(a.batchNumber, b.batchNumber);
  const alerts = batches.filter((batch) => batch.expiry.status !== "ok").sort(byExpiry);

  res.json({
    today,
    thresholds: [...warehouses.values()]
      .filter((w) => !warehouseId || w.id === warehouseId)
      .map((w) => ({ warehouseId: w.id, warehouseCode: w.code, ...thresholdsOf(w) })),
    counts: Object.fromEntries(
      ["expired", "critical", "near_expiry"].map((status) => [status, alerts.filter((a) => a.expiry.status === status).length])
    ),
    alerts,
    quarantineRequired: batches.filter((batch) => batch.requiresQuarantine).sort(byExpiry),
  });
});

const pickSchema = {
  warehouseId: rules.uuid({ required: true }),
  medicineId: rules.uuid({ required: true }),
  quantity: rules.int({ required: true, min: 1, max: 1_000_000 }),
};

// GET /api/warehouse/fefo/pick?warehouseId=&medicineId=&quantity=
// Which batches/locations to pick from, in FEFO order, and which stock is excluded and why.
router.get("/pick", async (req, res) => {
  const { warehouseId, medicineId, quantity } = validate(req.query, pickSchema);
  const today = todayISO();
  const [warehouse, medicine, stock] = await Promise.all([
    store.getWarehouse(warehouseId),
    store.getMedicine(medicineId),
    store.getStock({ warehouseId, medicineId }),
  ]);
  const plan = buildPickList(stock, quantity, today);
  const withExpiry = (item) => ({ ...item, expiry: classifyExpiry(item.expiryDate, today, thresholdsOf(warehouse)) });
  res.json({
    today,
    warehouse: toWarehouse(warehouse),
    medicine: toMedicine(medicine),
    ...plan,
    lines: plan.lines.map(withExpiry),
    excluded: plan.excluded.map(withExpiry),
  });
});

// POST /api/warehouse/fefo/dispatch { warehouseId, medicineId, quantity, reference?, notes? }
// Dispatches `quantity` units following the FEFO pick list (all picks FEFO-compliant).
router.post("/dispatch", requireActive, async (req, res) => {
  const values = validate(req.body, {
    ...pickSchema,
    reference: rules.string({ max: 120 }),
    notes: rules.string({ max: 1000 }),
  });
  const today = todayISO();
  const stock = await store.getStock({ warehouseId: values.warehouseId, medicineId: values.medicineId });
  const plan = buildPickList(stock, values.quantity, today);
  if (plan.shortfall > 0) {
    throw new HttpError(
      409,
      `Only ${plan.available} unit(s) can be dispatched (FEFO-eligible stock); ${values.quantity} requested`
    );
  }

  const ids = [];
  for (const line of plan.lines) {
    try {
      const row = await store.callMovementFunction(
        {
          batchId: line.batchId,
          movementType: "dispatch",
          quantity: line.pickQuantity,
          fromLocationId: line.storageLocationId,
          reference: values.reference,
          notes: values.notes,
        },
        { userId: req.user.id, today, fefoCompliant: true }
      );
      ids.push(row.id);
    } catch (error) {
      if (ids.length === 0) throw error;
      throw new HttpError(
        409,
        `Dispatch stopped after ${ids.length} of ${plan.lines.length} pick(s): ${error.message}. The completed picks were recorded.`,
        { completedMovementIds: ids }
      );
    }
  }

  const rows = unwrap(
    await supabase.from("inventory_movements").select(store.MOVEMENT_SELECT).in("id", ids).order("created_at")
  );
  res.status(201).json({ allocated: plan.allocated, movements: await mapMovements(rows) });
});

// GET /api/warehouse/fefo/compliance?warehouseId=&days=30
// Share of dispatches that followed FEFO, and the most recent overrides.
router.get("/compliance", async (req, res) => {
  const { warehouseId, days } = validate(req.query, {
    warehouseId: rules.uuid(),
    days: rules.int({ min: 1, max: 365, default: 30 }),
  });
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await store.fetchAll(() => {
    let query = supabase
      .from("inventory_movement_overview")
      .select(store.MOVEMENT_SELECT)
      .eq("movement_type", "dispatch")
      .gte("created_at", since)
      .order("id");
    if (warehouseId) query = query.eq("warehouse_id", warehouseId);
    return query;
  });

  const compliant = rows.filter((row) => row.fefo_compliant === true);
  const overrides = rows.filter((row) => row.fefo_compliant === false);
  const assessed = compliant.length + overrides.length;
  const recentOverrides = overrides.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10);

  res.json({
    days,
    since,
    dispatches: rows.length,
    units: sum(rows, (row) => row.quantity),
    compliant: compliant.length,
    overrides: overrides.length,
    // Dispatches recorded without a FEFO assessment (none via this API).
    notAssessed: rows.length - assessed,
    complianceRatePct: assessed ? Math.round((compliant.length / assessed) * 1000) / 10 : null,
    recentOverrides: await mapMovements(recentOverrides),
  });
});

module.exports = router;
