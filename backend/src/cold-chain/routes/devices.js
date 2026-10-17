// /api/cold-chain/devices - sensor devices (ESP32 loggers and the simulator).
//
// GET   /                admin/warehouse: devices and the shipment each reports for (never the key)
// POST  /                admin: register a device; the answer holds its key, shown only this once
// PATCH /:id             admin: name, notes, isActive (a deactivated device is refused)
// POST  /:id/rotate-key  admin: issue a new key; the old one stops working at once

const express = require("express");
const { supabase, audit } = require("../store");
const { HttpError, unwrap } = require("../errors");
const { requireAdmin, requireWarehouseStaff } = require("../../pharmacy/auth");
const { generateDeviceKey, hashDeviceKey } = require("../device-auth");
const { parse, z, id, deviceCreate, deviceUpdate } = require("../validation");
const { toDevice } = require("../mappers");

const router = express.Router();

const DEVICE_COLUMNS = "id, device_code, name, device_type, is_active, last_seen_at, notes, created_at";
const KEY_NOTE = "Store this key on the device now. It is not shown again.";

router.get("/", requireWarehouseStaff, async (_req, res) => {
  const rows = unwrap(await supabase.from("cold_chain_devices").select(DEVICE_COLUMNS).order("device_code"));
  const assigned = rows.length
    ? unwrap(
        await supabase
          .from("cold_chain_shipments")
          .select("device_id, shipment_id, shipment:shipments(shipment_number)")
          .eq("monitoring_status", "active")
          .in("device_id", rows.map((row) => row.id))
      )
    : [];
  const byDevice = new Map(
    assigned.map((a) => [a.device_id, { shipmentId: a.shipment_id, shipmentNumber: a.shipment?.shipment_number ?? null }])
  );
  res.json({ devices: rows.map((row) => ({ ...toDevice(row), activeShipment: byDevice.get(row.id) ?? null })) });
});

router.post("/", requireAdmin, async (req, res) => {
  const body = parse(deviceCreate, req.body);
  const deviceKey = generateDeviceKey();
  const row = unwrap(
    await supabase
      .from("cold_chain_devices")
      .insert({
        device_code: body.deviceCode,
        name: body.name ?? null,
        device_type: body.deviceType ?? "esp32",
        notes: body.notes ?? null,
        key_hash: hashDeviceKey(deviceKey),
        created_by: req.user.id,
      })
      .select(DEVICE_COLUMNS)
      .single()
  );
  await audit(req, {
    action: "cold_chain.device_registered",
    entityType: "cold_chain_device",
    entityId: row.id,
    details: { deviceCode: row.device_code, deviceType: row.device_type },
  });
  res.status(201).json({ device: toDevice(row), deviceKey, note: KEY_NOTE });
});

router.patch("/:id", requireAdmin, async (req, res) => {
  const { id: deviceId } = parse(z.object({ id }), req.params);
  const body = parse(deviceUpdate, req.body);
  const changes = {};
  if (body.name !== undefined) changes.name = body.name || null;
  if (body.notes !== undefined) changes.notes = body.notes || null;
  if (body.isActive !== undefined) changes.is_active = body.isActive;
  if (Object.keys(changes).length === 0) throw new HttpError(400, "Nothing to change");

  const row = unwrap(
    await supabase.from("cold_chain_devices").update(changes).eq("id", deviceId).select(DEVICE_COLUMNS).maybeSingle()
  );
  if (!row) throw new HttpError(404, "Device not found");
  await audit(req, { action: "cold_chain.device_updated", entityType: "cold_chain_device", entityId: row.id, details: body });
  res.json({ device: toDevice(row) });
});

router.post("/:id/rotate-key", requireAdmin, async (req, res) => {
  const { id: deviceId } = parse(z.object({ id }), req.params);
  const deviceKey = generateDeviceKey();
  const row = unwrap(
    await supabase
      .from("cold_chain_devices")
      .update({ key_hash: hashDeviceKey(deviceKey) })
      .eq("id", deviceId)
      .select(DEVICE_COLUMNS)
      .maybeSingle()
  );
  if (!row) throw new HttpError(404, "Device not found");
  await audit(req, { action: "cold_chain.device_key_rotated", entityType: "cold_chain_device", entityId: row.id });
  res.json({ device: toDevice(row), deviceKey, note: KEY_NOTE });
});

module.exports = router;
