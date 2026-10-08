// /api/warehouse/batches - batches, their stock and status.

const express = require("express");
const store = require("../store");
const { HttpError, fromDbError, unwrap } = require("../errors");
const { rules, validate, fieldError } = require("../validation");
const { requireActive, requireAdmin } = require("../auth");
const { toBatch } = require("../mappers");
const { todayISO } = require("../dates");
const { classifyExpiry, thresholdsOf, widestThresholds, EXPIRY_STATUSES } = require("../expiry");
const { BATCH_STATUSES, SETTABLE_BATCH_STATUSES } = require("../constants");
const { createQrCode, getBatchDetail, groupBy, sum, warehousesById } = require("../services");

const router = express.Router();
const { supabase } = store;

// GET /api/warehouse/batches?medicineId=&status=&expiryStatus=&inStock=&q=
router.get("/", async (req, res) => {
  const filters = validate(req.query, {
    medicineId: rules.uuid(),
    status: rules.oneOf(BATCH_STATUSES),
    expiryStatus: rules.oneOf(EXPIRY_STATUSES),
    inStock: rules.bool(),
    q: rules.string({ max: 100 }),
  });
  const today = todayISO();
  const [rows, stock, warehouses, qrRows] = await Promise.all([
    store.fetchAll(() => {
      let query = supabase.from("batches").select(store.BATCH_SELECT).order("id");
      if (filters.medicineId) query = query.eq("medicine_id", filters.medicineId);
      if (filters.status) query = query.eq("status", filters.status);
      return query;
    }),
    store.getStock({ medicineId: filters.medicineId }),
    warehousesById(),
    store.fetchAll(() => supabase.from("batch_qr_codes").select("batch_id, code").eq("is_active", true).order("id")),
  ]);
  const stockByBatch = groupBy(stock, (item) => item.batchId);
  const activeCode = new Map(qrRows.map((row) => [row.batch_id, row.code]));
  const needle = filters.q?.toLowerCase();

  const batches = rows
    .map((row) => {
      const held = stockByBatch.get(row.id) ?? [];
      const warehouseIds = [...new Set(held.map((item) => item.warehouseId))];
      const thresholds = widestThresholds(warehouseIds.map((id) => thresholdsOf(warehouses.get(id))));
      return {
        ...toBatch(row),
        expiry: classifyExpiry(row.expiry_date, today, thresholds),
        totalQuantity: sum(held, (item) => item.quantity),
        locationCount: held.length,
        warehouseCodes: warehouseIds.map((id) => warehouses.get(id)?.code),
        qrCode: activeCode.get(row.id) ?? null,
      };
    })
    .filter((batch) => !filters.expiryStatus || batch.expiry.status === filters.expiryStatus)
    .filter((batch) => filters.inStock === undefined || (batch.totalQuantity > 0) === filters.inStock)
    .filter(
      (batch) =>
        !needle ||
        batch.batchNumber.toLowerCase().includes(needle) ||
        batch.medicine?.name.toLowerCase().includes(needle)
    )
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || store.naturalCompare(a.batchNumber, b.batchNumber));

  res.json({ today, batches });
});

router.get("/:id", async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  res.json(await getBatchDetail(id, todayISO()));
});

// POST /api/warehouse/batches - registers a batch and issues its QR code.
// Stock is added afterwards with a "receive" movement.
router.post("/", requireActive, async (req, res) => {
  const values = validate(req.body, {
    medicineId: rules.uuid({ required: true }),
    batchNumber: rules.string({ required: true, max: 60 }),
    manufacturingDate: rules.date(),
    expiryDate: rules.date({ required: true }),
    supplier: rules.string({ max: 200 }),
    notes: rules.string({ max: 1000 }),
  });
  const today = todayISO();
  if (values.expiryDate < today) throw fieldError("expiryDate", "is in the past; expired stock cannot be received");
  if (values.manufacturingDate && values.manufacturingDate > today) {
    throw fieldError("manufacturingDate", "cannot be in the future");
  }
  if (values.manufacturingDate && values.manufacturingDate >= values.expiryDate) {
    throw fieldError("manufacturingDate", "must be before the expiry date");
  }

  const medicine = await store.getMedicine(values.medicineId);
  if (!medicine.is_active) throw new HttpError(409, `${medicine.name} is inactive`);

  const { data, error } = await supabase
    .from("batches")
    .insert({
      medicine_id: values.medicineId,
      batch_number: values.batchNumber,
      manufacturing_date: values.manufacturingDate ?? null,
      expiry_date: values.expiryDate,
      supplier: values.supplier ?? null,
      notes: values.notes ?? null,
      created_by: req.user.id,
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    const existing = unwrap(
      await supabase.from("batches").select("id")
        .eq("medicine_id", values.medicineId).eq("batch_number", values.batchNumber).maybeSingle()
    );
    throw new HttpError(409, `Batch ${values.batchNumber} of ${medicine.name} is already registered`, {
      existingBatchId: existing?.id,
    });
  }
  if (error) throw fromDbError(error);

  const qr = await createQrCode(data.id, req.user.id);
  res.status(201).json({ batch: toBatch(await store.getBatch(data.id)), qr });
});

// PATCH /api/warehouse/batches/:id - status changes (quarantine, recall, release).
router.patch("/:id", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const values = validate(req.body, {
    status: rules.oneOf(SETTABLE_BATCH_STATUSES, { required: true }),
    notes: rules.string({ max: 1000, nullable: true }),
  });
  const current = await store.getBatch(id);
  if (current.status === "disposed") throw new HttpError(409, "Disposed batches cannot change status");
  const update = { status: values.status, ...(values.notes !== undefined && { notes: values.notes }) };
  unwrap(await supabase.from("batches").update(update).eq("id", id));
  res.json({ batch: toBatch(await store.getBatch(id)) });
});

module.exports = router;
