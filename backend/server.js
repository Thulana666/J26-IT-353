const express = require("express");
const cors = require("cors");
require("dotenv").config();

const supabase = require("./src/config/supabase");
const ingestionRoutes = require("./src/ingestion/routes");
const { medicinesRouter, warehouseRouter } = require("./src/warehouse");

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

// Component 3: warehouse FEFO, QR and spatial allocation (see src/warehouse/).
app.use("/api/medicines", medicinesRouter);
app.use("/api/warehouse", warehouseRouter);

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