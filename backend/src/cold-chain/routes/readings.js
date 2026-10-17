// POST /api/cold-chain/readings - sensor readings from a device (ESP32 logger
// or the development simulator). Authenticated with the device's own key
// (X-Device-Id + X-Device-Key, see device-auth.js), not a user session.
//
// Body: one reading, or a batch (e.g. a buffer uploaded after a connection gap):
//   { recordedAt, temperatureC?, humidityPct?, latitude?, longitude?, speedKmh?, vibrationG? }
//   { shipmentId? | shipmentNumber?, readings: [ ...up to 300 readings ] }
// recordedAt: ISO 8601 with a time zone, or Unix seconds. Without a shipment,
// the device's active assignment is used.
//
// Each reading is checked on its own: valid ones are stored even when others
// in the batch are rejected, and a resent reading (same time) is reported as a
// duplicate instead of being stored twice. Devices should drop readings from
// their buffer on any 2xx or 4xx answer and retry only on 5xx or no answer.
//
// 201 { shipmentId, shipmentNumber, accepted, duplicates: [time], rejected: [{ index, errors }], alerts }
// 200 the same, when nothing new was stored (all duplicates)
// 400 when no reading in the request is valid

const express = require("express");
const { supabase, previousReading, insertReadings, recordObservedAlerts } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { authenticateDevice } = require("../device-auth");
const { parseIngestBody, checkReading } = require("../validation");
const { timeWindowError, qualityFlags } = require("../quality");

const router = express.Router();

const INGEST_SELECT =
  "shipment_id, device_id, temp_min_c, temp_max_c, humidity_min_pct, humidity_max_pct, reading_interval_seconds, " +
  "is_test, monitoring_status, started_at, ended_at, shipment:shipments!inner(shipment_number, received_at)";

// The monitored shipment this device reports for: the one named in the request
// (an active or ended assignment, for buffered readings), else its active one.
async function findShipmentForDevice(device, { shipmentId, shipmentNumber }) {
  let query = supabase.from("cold_chain_shipments").select(INGEST_SELECT).eq("device_id", device.id);
  if (shipmentId) query = query.eq("shipment_id", shipmentId);
  else if (shipmentNumber) query = query.eq("shipment.shipment_number", shipmentNumber);
  else query = query.eq("monitoring_status", "active");
  const rows = unwrap(await query.order("started_at", { ascending: false }).limit(1));
  if (rows.length === 0) {
    throw new HttpError(
      409,
      shipmentId || shipmentNumber
        ? "This device is not assigned to that shipment"
        : "This device is not assigned to an active shipment"
    );
  }
  return rows[0];
}

const iso = (ms) => new Date(ms).toISOString();

router.post("/", authenticateDevice, async (req, res) => {
  const now = Date.now();
  const { device } = req;
  const { target, readings } = parseIngestBody(req.body);
  const monitor = await findShipmentForDevice(device, target);
  const isSimulator = device.device_type === "simulator";
  if (isSimulator && !monitor.is_test) {
    throw new HttpError(409, "A simulator can only report for test shipments");
  }

  const valid = [];
  const rejected = [];
  const duplicates = [];
  const seen = new Set();
  readings.forEach((raw, index) => {
    const { reading, errors } = checkReading(raw);
    if (errors) return rejected.push({ index, errors });
    const timeError = timeWindowError(reading.recordedAt, monitor, now);
    if (timeError) return rejected.push({ index, errors: { recordedAt: timeError } });
    if (seen.has(reading.recordedAt)) return duplicates.push(iso(reading.recordedAt));
    seen.add(reading.recordedAt);
    valid.push(reading);
  });
  if (valid.length === 0) {
    if (rejected.length) throw new HttpError(400, "No valid readings", { rejected });
    return res.json({ shipmentId: monitor.shipment_id, accepted: 0, duplicates, rejected, alerts: null });
  }

  valid.sort((a, b) => a.recordedAt - b.recordedAt);
  const flags = qualityFlags(valid, {
    previous: await previousReading(monitor.shipment_id, valid[0].recordedAt),
    intervalSeconds: monitor.reading_interval_seconds,
    receivedAtMs: now,
    deliveredAt: monitor.shipment.received_at,
  });
  const inserted = await insertReadings(
    valid.map((reading, i) => ({
      shipment_id: monitor.shipment_id,
      device_id: device.id,
      source: isSimulator ? "simulator" : "device",
      recorded_at: iso(reading.recordedAt),
      received_at: iso(now),
      temperature_c: reading.temperatureC ?? null,
      humidity_pct: reading.humidityPct ?? null,
      latitude: reading.latitude ?? null,
      longitude: reading.longitude ?? null,
      speed_kmh: reading.speedKmh ?? null,
      vibration_g: reading.vibrationG ?? null,
      quality_flags: flags[i],
    }))
  );
  const insertedAt = new Set(inserted.map((row) => Date.parse(row.recorded_at)));
  for (const reading of valid) if (!insertedAt.has(reading.recordedAt)) duplicates.push(iso(reading.recordedAt));

  const { error: touchError } = await supabase.from("cold_chain_devices").update({ last_seen_at: iso(now) }).eq("id", device.id);
  if (touchError) console.error(`[cold-chain] could not update last_seen_at: ${touchError.message}`);

  // The readings are stored; an alert failure must not make the device resend them.
  let alerts = null;
  if (inserted.length) {
    try {
      alerts = await recordObservedAlerts(monitor, valid.filter((r) => insertedAt.has(r.recordedAt)), now);
    } catch (error) {
      console.error(`[cold-chain] alert evaluation failed for ${monitor.shipment_id}: ${error.message}`);
    }
  }

  res.status(inserted.length ? 201 : 200).json({
    shipmentId: monitor.shipment_id,
    shipmentNumber: monitor.shipment.shipment_number,
    accepted: inserted.length,
    duplicates,
    rejected,
    alerts,
  });
});

module.exports = router;
