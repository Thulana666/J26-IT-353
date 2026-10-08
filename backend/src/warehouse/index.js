// Component 3: Intelligent Warehouse FEFO & QR Management.
//
//   /api/medicines           shared medicine master data
//   /api/warehouse/...       warehouses, storage, batches, inventory, FEFO,
//                            QR, movements, spatial allocation, state
//
// Every route needs a signed-in user (see auth.js). Errors are JSON.

const express = require("express");
const { authenticate } = require("./auth");
const { errorHandler } = require("./errors");

const notFound = (_req, res) => res.status(404).json({ error: "Not found" });

const medicinesRouter = express.Router();
medicinesRouter.use(authenticate);
medicinesRouter.use(require("./routes/medicines"));
medicinesRouter.use(errorHandler);

const warehouseRouter = express.Router();
warehouseRouter.use(authenticate);
warehouseRouter.use("/warehouses", require("./routes/warehouses"));
warehouseRouter.use("/storage", require("./routes/storage"));
warehouseRouter.use("/batches", require("./routes/batches"));
warehouseRouter.use("/inventory", require("./routes/inventory"));
warehouseRouter.use("/fefo", require("./routes/fefo"));
warehouseRouter.use("/qr", require("./routes/qr"));
warehouseRouter.use("/movements", require("./routes/movements"));
warehouseRouter.use("/spatial", require("./routes/spatial"));
warehouseRouter.use("/state", require("./routes/state"));
warehouseRouter.use(notFound);
warehouseRouter.use(errorHandler);

// Each export is [router, errorHandler] for app.use(path, ...). The trailing
// handler also answers errors raised before the router runs, such as an
// invalid JSON body rejected by the app-wide express.json().
module.exports = {
  medicinesRouter: [medicinesRouter, errorHandler],
  warehouseRouter: [warehouseRouter, errorHandler],
};
