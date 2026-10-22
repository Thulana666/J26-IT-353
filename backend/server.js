const express = require("express");
const cors = require("cors");
require("dotenv").config();

const supabase = require("./src/config/supabase");
const ingestionRoutes = require("./src/ingestion/routes");
const { eventIntelRouter } = require("./src/event-intel/routes");
const { medicinesRouter, warehouseRouter } = require("./src/warehouse");
const { pharmacyRouter } = require("./src/pharmacy");
const { coldChainRouter } = require("./src/cold-chain");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "PharmaTwin Intelligent Warehouse API is running",
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const { error } = await supabase
      .from("medicines")
      .select("id")
      .limit(1);

    if (error) {
      return res.status(500).json({
        status: "error",
        message: "Supabase connection failed",
        error: error.message,
      });
    }

    res.json({
      status: "success",
      message: "Backend connected to Supabase successfully",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "Supabase connection failed",
      error: error.message,
    });
  }
});

// Component 1: article ingestion trigger (see src/ingestion/routes.js).
app.use("/api/ingestion", ingestionRoutes);
// Component 1: NLP analysis of collected articles (see src/event-intel/).
app.use("/api/event-intel", eventIntelRouter);
// Optional scheduled collection + analysis (minutes; 0 or unset = off). Runs
// inside this process, so it only works while the backend is running.
const pipelineInterval = Number(process.env.EVENT_INTEL_PIPELINE_INTERVAL_MINUTES) || 0;
if (pipelineInterval > 0) require("./src/event-intel/pipeline").startSchedule(supabase, pipelineInterval);

// Component 3: warehouse FEFO, QR and spatial allocation (see src/warehouse/).
app.use("/api/medicines", medicinesRouter);
app.use("/api/warehouse", warehouseRouter);

// Component 4: pharmacy orders, shipments, POS, returns and inventory.
app.use("/api/pharmacy", pharmacyRouter);

// Component 2: IoT cold-chain monitoring, sensor readings and alerts.
app.use("/api/cold-chain", coldChainRouter);

const PORT = process.env.PORT || 5000;

app.listen(PORT, (error) => {
  // Express 5 reports listen errors (e.g. port already in use) here.
  if (error) {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${PORT} is already in use - is another backend already running?`
        : `Could not start server: ${error.message}`
    );
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
});