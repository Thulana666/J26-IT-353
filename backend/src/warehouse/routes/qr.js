// /api/warehouse/qr - QR lookup (scan), label images and code rotation.

const express = require("express");
const store = require("../store");
const { HttpError, unwrap } = require("../errors");
const { rules, validate } = require("../validation");
const { requireAdmin } = require("../auth");
const { todayISO } = require("../dates");
const { parseQrInput } = require("../qr");
const { toQrCode } = require("../mappers");
const { getBatchDetail, rotateQrCode, withImage } = require("../services");
const { recordScan } = require("../scans");

const router = express.Router();
const { supabase } = store;

// POST /api/warehouse/qr/resolve { payload } - a scanned payload or a typed code.
// 400 invalid format/check character, 404 unknown code, 410 deactivated code.
// Every lookup is recorded in the scan history.
router.post("/resolve", async (req, res) => {
  const payload = typeof req.body?.payload === "string" ? req.body.payload : "";
  const scan = { purpose: "lookup", scannedCode: payload, userId: req.user.id };
  const parsed = parseQrInput(payload);
  if (!parsed.ok) {
    await recordScan({ ...scan, result: "invalid", message: parsed.message });
    throw new HttpError(400, parsed.message, { reason: parsed.reason });
  }

  const row = unwrap(await supabase.from("batch_qr_codes").select("*").eq("code", parsed.code).maybeSingle());
  if (!row) {
    await recordScan({ ...scan, result: "not_found" });
    throw new HttpError(404, "This QR code is not registered in PharmaTwin", { reason: "not_found" });
  }
  if (!row.is_active) {
    await recordScan({ ...scan, result: "inactive", batchId: row.batch_id });
    const replacement = unwrap(
      await supabase.from("batch_qr_codes").select("id").eq("batch_id", row.batch_id).eq("is_active", true).maybeSingle()
    );
    throw new HttpError(
      410,
      `This label was deactivated on ${row.deactivated_at.slice(0, 10)}. ` +
        (replacement ? "The batch has a newer label; use that one." : "The batch has no active label."),
      { reason: "inactive", batchId: row.batch_id, deactivatedAt: row.deactivated_at }
    );
  }

  await recordScan({ ...scan, result: "ok", batchId: row.batch_id });
  res.json({ scannedCode: row.code, ...(await getBatchDetail(row.batch_id, todayISO())) });
});

// GET /api/warehouse/qr/batch/:batchId - the active label (with image) and old codes.
router.get("/batch/:batchId", async (req, res) => {
  const { batchId } = validate(req.params, { batchId: rules.uuid({ required: true }) });
  await store.getBatch(batchId);
  const rows = unwrap(
    await supabase.from("batch_qr_codes").select("*").eq("batch_id", batchId).order("created_at", { ascending: false })
  );
  const active = rows.find((row) => row.is_active);
  res.json({
    active: active ? await withImage(toQrCode(active)) : null,
    history: rows.filter((row) => !row.is_active).map(toQrCode),
  });
});

// POST /api/warehouse/qr/batch/:batchId - issue a new label (deactivates the current one).
router.post("/batch/:batchId", async (req, res) => {
  const { batchId } = validate(req.params, { batchId: rules.uuid({ required: true }) });
  res.status(201).json({ qr: await rotateQrCode(batchId, req.user.id) });
});

// POST /api/warehouse/qr/:id/deactivate - e.g. a lost label.
router.post("/:id/deactivate", requireAdmin, async (req, res) => {
  const { id } = validate(req.params, { id: rules.uuid({ required: true }) });
  const rows = unwrap(
    await supabase
      .from("batch_qr_codes")
      .update({ is_active: false, deactivated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("is_active", true)
      .select()
  );
  if (rows.length === 0) throw new HttpError(404, "No active QR code with this id");
  res.json({ qr: toQrCode(rows[0]) });
});

module.exports = router;
