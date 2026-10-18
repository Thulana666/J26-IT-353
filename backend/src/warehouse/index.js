// Component 3: Intelligent Warehouse FEFO & QR Management.
//
//   /api/medicines           shared medicine master data (read: staff, write: admins)
//   /api/warehouse/...       warehouses, storage, batches, inventory, FEFO, QR,
//                            movements, spatial allocation, state, pharmacy
//                            order fulfilment, discrepancy reports, returns,
//                            integration handoffs, scan history
//
// Every warehouse route needs an active admin or warehouse_staff account
// (see auth.js); some routes are admin-only. Errors are JSON.

const express = require("express");
const { authenticate, requireWarehouseStaff } = require("./auth");
const { errorHandler } = require("./errors");

const notFound = (_req, res) => res.status(404).json({ error: "Not found" });

const medicinesRouter = express.Router();
medicinesRouter.use(authenticate);
medicinesRouter.use(require("./routes/medicines"));
medicinesRouter.use(errorHandler);

const warehouseRouter = express.Router();
warehouseRouter.use(authenticate, requireWarehouseStaff);
warehouseRouter.use("/warehouses", require("./routes/warehouses"));
warehouseRouter.use("/storage", require("./routes/storage"));
warehouseRouter.use("/batches", require("./routes/batches"));
warehouseRouter.use("/inventory", require("./routes/inventory"));
warehouseRouter.use("/fefo", require("./routes/fefo"));
warehouseRouter.use("/qr", require("./routes/qr"));
warehouseRouter.use("/movements", require("./routes/movements"));
warehouseRouter.use("/spatial", require("./routes/spatial"));
warehouseRouter.use("/state", require("./routes/state"));
warehouseRouter.use("/orders", require("./routes/orders"));
warehouseRouter.use("/discrepancies", require("./routes/discrepancies"));
warehouseRouter.use("/returns", require("./routes/returns"));
warehouseRouter.use("/integrations", require("./routes/integrations"));
warehouseRouter.use("/scans", require("./routes/scans"));
warehouseRouter.use("/staff", require("./routes/staff"));
warehouseRouter.use(notFound);
warehouseRouter.use(errorHandler);

// Each export is [router, errorHandler] for app.use(path, ...). The trailing
// handler also answers errors raised before the router runs, such as an
// invalid JSON body rejected by the app-wide express.json().
module.exports = {
  medicinesRouter: [medicinesRouter, errorHandler],
  warehouseRouter: [warehouseRouter, errorHandler],
};
