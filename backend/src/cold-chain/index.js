// Component 2: IoT Cold-Chain Tracking & Logistics Risk Prediction.
//
//   /api/cold-chain/readings    POST sensor readings (device key, not a user session)
//   /api/cold-chain/shipments   monitored shipments, readings, alerts, risk
//   /api/cold-chain/alerts      acknowledge alerts
//   /api/cold-chain/devices     ESP32 / simulator registry and keys
//
// Everything except /readings needs a signed-in user; roles as in the
// pharmacy module (see ../pharmacy/auth.js). Errors are JSON.

const express = require("express");
const { authenticate } = require("../pharmacy/auth");
const { errorHandler } = require("./errors");

const notFound = (_req, res) => res.status(404).json({ error: "Not found" });

const coldChainRouter = express.Router();
// Devices authenticate with their own key, so this comes before `authenticate`.
coldChainRouter.use("/readings", require("./routes/readings"));
coldChainRouter.use(authenticate);
coldChainRouter.use("/shipments", require("./routes/shipments"));
coldChainRouter.use("/alerts", require("./routes/alerts"));
coldChainRouter.use("/devices", require("./routes/devices"));
coldChainRouter.use(notFound);
coldChainRouter.use(errorHandler);

// [router, errorHandler] for app.use(path, ...), like the other modules.
module.exports = { coldChainRouter: [coldChainRouter, errorHandler] };
