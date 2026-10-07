// /api/warehouse/inventory - current stock (one row per batch per location).

const express = require("express");
const store = require("../store");
const { rules, validate } = require("../validation");
const { todayISO } = require("../dates");
const { EXPIRY_STATUSES } = require("../expiry");
const { ZONE_TYPES } = require("../constants");
const { classifyStock, getSummary, sum, warehousesById } = require("../services");

const router = express.Router();

// GET /api/warehouse/inventory?warehouseId=&medicineId=&expiryStatus=&zoneType=&q=&page=&pageSize=
// Ordered by expiry (FEFO view).
router.get("/", async (req, res) => {
  const filters = validate(req.query, {
    warehouseId: rules.uuid(),
    medicineId: rules.uuid(),
    expiryStatus: rules.oneOf(EXPIRY_STATUSES),
    zoneType: rules.oneOf(ZONE_TYPES),
    q: rules.string({ max: 100 }),
    page: rules.int({ min: 1, default: 1 }),
    pageSize: rules.int({ min: 1, max: 200, default: 50 }),
  });
  const today = todayISO();
  const [warehouses, stock] = await Promise.all([
    warehousesById(),
    store.getStock({ warehouseId: filters.warehouseId, medicineId: filters.medicineId }),
  ]);
  const needle = filters.q?.toLowerCase();
  const items = classifyStock(stock, warehouses, today)
    .filter((item) => !filters.expiryStatus || item.expiry.status === filters.expiryStatus)
    .filter((item) => !filters.zoneType || item.zoneType === filters.zoneType)
    .filter(
      (item) =>
        !needle ||
        item.medicineName.toLowerCase().includes(needle) ||
        item.batchNumber.toLowerCase().includes(needle) ||
        item.locationCode.toLowerCase().includes(needle)
    )
    .sort(
      (a, b) =>
        a.expiryDate.localeCompare(b.expiryDate) ||
        store.naturalCompare(a.medicineName, b.medicineName) ||
        store.byLocationCode(a, b)
    );

  const pageCount = Math.max(1, Math.ceil(items.length / filters.pageSize));
  const page = Math.min(filters.page, pageCount);
  res.json({
    today,
    items: items.slice((page - 1) * filters.pageSize, page * filters.pageSize),
    page,
    pageSize: filters.pageSize,
    pageCount,
    total: items.length,
    totalUnits: sum(items, (item) => item.quantity),
  });
});

// GET /api/warehouse/inventory/summary?warehouseId= - dashboard figures.
router.get("/summary", async (req, res) => {
  const { warehouseId } = validate(req.query, { warehouseId: rules.uuid() });
  res.json(await getSummary({ warehouseId }, todayISO()));
});

module.exports = router;
