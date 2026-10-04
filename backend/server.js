const express = require("express");
const cors = require("cors");
require("dotenv").config();

const supabase = require("./src/config/supabase");

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

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});