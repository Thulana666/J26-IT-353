// Component 2: IoT Cold-Chain Tracking & Logistics Risk Prediction.
//
//   /api/cold-chain/readings    POST sensor readings (device key, not a user session)
//   /api/cold-chain/shipments   monitored shipments, readings, alerts, risk
//   /api/cold-chain/alerts      acknowledge alerts
//   /api/cold-chain/devices     ESP32 / simulator registry and keys
//   /api/cold-chain/drivers     drivers (admins and warehouse staff)
//   /api/cold-chain/trucks      trucks (admins and warehouse staff)
//   /api/cold-chain/issues      driver-reported issues (staff update their status)
//   /api/cold-chain/driver      the Driver Portal: a driver's own deliveries, delivery confirmation, issues
//
// Everything except /readings needs a signed-in user; roles as in the
// pharmacy module (see ../pharmacy/auth.js). Errors are JSON.
//
// COLD_CHAIN_RISK_INTERVAL_MINUTES (default 5, 0 = off): how often the risk of
// trips in transit is re-evaluated without new readings (delays, silent sensors).

const express = require("express");
const { authenticate } = require("../pharmacy/auth");
const { errorHandler } = require("./errors");
const fleet = require("./routes/fleet");

const notFound = (_req, res) => res.status(404).json({ error: "Not found" });

const coldChainRouter = express.Router();
// Devices authenticate with their own key, so this comes before `authenticate`.
coldChainRouter.use("/readings", require("./routes/readings"));
coldChainRouter.use(authenticate);
coldChainRouter.use("/shipments", require("./routes/shipments"));
coldChainRouter.use("/alerts", require("./routes/alerts"));
coldChainRouter.use("/devices", require("./routes/devices"));
coldChainRouter.use("/drivers", fleet.drivers);
coldChainRouter.use("/trucks", fleet.trucks);
coldChainRouter.use("/issues", require("./routes/issues"));
coldChainRouter.use("/driver", require("./routes/driver"));
coldChainRouter.use(notFound);
coldChainRouter.use(errorHandler);

const riskIntervalMinutes = Number(process.env.COLD_CHAIN_RISK_INTERVAL_MINUTES ?? 5);
if (riskIntervalMinutes > 0) require("./risk/scheduler").start(riskIntervalMinutes);

// [router, errorHandler] for app.use(path, ...), like the other modules.
module.exports = { coldChainRouter: [coldChainRouter, errorHandler] };
