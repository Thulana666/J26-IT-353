// Component 4: Intelligent Pharmacy Analytics & Stock Optimization.
//
//   /api/pharmacy/context          who am I, which pharmacies can I use
//   /api/pharmacy/dashboard        pharmacy KPIs
//   /api/pharmacy/inventory        stock by product and batch, barcode lookup
//   /api/pharmacy/orders           orders to the warehouse; warehouse dispatch
//   /api/pharmacy/shipments        incoming shipments and receipt confirmation
//   /api/pharmacy/discrepancies    discrepancy reports (pharmacy -> warehouse)
//   /api/pharmacy/sales            POS checkout and receipts
//   /api/pharmacy/returns          returns to the warehouse
//   /api/pharmacy/analytics        burn rates, forecasts, Q*, research metrics
//   /api/pharmacy/recommendations  reorder recommendations and decisions
//   /api/pharmacy/alerts           low stock, stockout, expiry, unusual consumption
//   /api/pharmacy/settings         pharmacy profile, defaults, reorder settings
//   /api/pharmacy/admin            users, pharmacies, products, barcodes
//
// Every route needs a signed-in user (see auth.js). Errors are JSON.

const express = require("express");
const { authenticate } = require("./auth");
const { errorHandler } = require("./errors");

const notFound = (_req, res) => res.status(404).json({ error: "Not found" });

const pharmacyRouter = express.Router();
pharmacyRouter.use(authenticate);
pharmacyRouter.use("/context", require("./routes/context"));
pharmacyRouter.use("/dashboard", require("./routes/dashboard"));
pharmacyRouter.use("/inventory", require("./routes/inventory"));
pharmacyRouter.use("/orders", require("./routes/orders"));
pharmacyRouter.use("/shipments", require("./routes/shipments"));
pharmacyRouter.use("/discrepancies", require("./routes/discrepancies"));
pharmacyRouter.use("/sales", require("./routes/sales"));
pharmacyRouter.use("/returns", require("./routes/returns"));
pharmacyRouter.use("/analytics", require("./routes/analytics"));
pharmacyRouter.use("/recommendations", require("./routes/recommendations"));
pharmacyRouter.use("/alerts", require("./routes/alerts"));
pharmacyRouter.use("/settings", require("./routes/settings"));
pharmacyRouter.use("/admin", require("./routes/admin"));
pharmacyRouter.use(notFound);
pharmacyRouter.use(errorHandler);

// Optional background job: re-run forecasts for every active pharmacy every
// PHARMACY_FORECAST_INTERVAL_HOURS hours (the feedback loop without clicks).
const intervalHours = Number(process.env.PHARMACY_FORECAST_INTERVAL_HOURS);
if (intervalHours > 0) require("./analytics/scheduler").start(intervalHours);

// [router, errorHandler] for app.use(path, ...), like the warehouse module.
module.exports = { pharmacyRouter: [pharmacyRouter, errorHandler] };
