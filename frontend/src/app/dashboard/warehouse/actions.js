"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { WarehouseApiError, warehouseApi } from "@/lib/warehouse/api";
import { MOVEMENT_LABELS } from "@/lib/warehouse/format";

// Server actions for the warehouse pages. Each returns { ok: true, message }
// or { ok: false, error, fields } for <ActionForm>. The backend validates
// everything and applies role checks; these only pass the form values on.

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function failure(error) {
  if (!(error instanceof WarehouseApiError)) throw error;
  return { ok: false, error: error.message, fields: error.details?.fields ?? null };
}

function refresh() {
  revalidatePath("/dashboard/warehouse", "layout");
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Receive, transfer, dispatch, adjustment or disposal of one batch.
export async function recordMovementAction(_previous, formData) {
  const body = {
    batchId: text(formData, "batchId"),
    movementType: text(formData, "movementType"),
    quantity: text(formData, "quantity"),
    fromLocationId: text(formData, "fromLocationId"),
    toLocationId: text(formData, "toLocationId"),
    performedVia: text(formData, "performedVia"),
    reference: text(formData, "reference"),
    notes: text(formData, "notes"),
    fefoOverrideReason: text(formData, "fefoOverrideReason"),
  };
  // Adjustments: one location, counted down (out of it) or up (into it).
  const adjustLocationId = text(formData, "adjustLocationId");
  if (body.movementType === "adjustment" && adjustLocationId) {
    body[text(formData, "adjustDirection") === "in" ? "toLocationId" : "fromLocationId"] = adjustLocationId;
  }
  try {
    const { movement } = await warehouseApi("/warehouse/movements", { method: "POST", body });
    refresh();
    const label = MOVEMENT_LABELS[movement.movementType] ?? "Movement";
    const fefo = movement.fefoCompliant === false ? " (recorded as a FEFO override)" : "";
    return { ok: true, message: `${label} of ${plural(movement.quantity, "unit")} recorded${fefo}.` };
  } catch (error) {
    return failure(error);
  }
}

// Registers an incoming batch (with its QR label) and puts it away in the
// chosen location, then opens the batch page.
export async function receiveBatchAction(_previous, formData) {
  let batchId = text(formData, "batchId");
  let registered = false;
  try {
    if (!batchId) {
      const { batch } = await warehouseApi("/warehouse/batches", {
        method: "POST",
        body: {
          medicineId: text(formData, "medicineId"),
          batchNumber: text(formData, "batchNumber"),
          manufacturingDate: text(formData, "manufacturingDate"),
          expiryDate: text(formData, "expiryDate"),
          supplier: text(formData, "supplier"),
        },
      });
      batchId = batch.id;
      registered = true;
    }
    await warehouseApi("/warehouse/movements", {
      method: "POST",
      body: {
        batchId,
        movementType: "receive",
        quantity: text(formData, "quantity"),
        toLocationId: text(formData, "toLocationId"),
        reference: text(formData, "reference"),
      },
    });
  } catch (error) {
    const result = failure(error);
    if (registered) {
      refresh();
      result.error += " The batch was registered without stock; open it from Inventory to receive it.";
    }
    return result;
  }
  refresh();
  redirect(`/dashboard/warehouse/batches/${batchId}`);
}

// Dispatches a quantity of one medicine following the FEFO pick list, then
// shows the recorded dispatches.
export async function dispatchFefoAction(_previous, formData) {
  try {
    await warehouseApi("/warehouse/fefo/dispatch", {
      method: "POST",
      body: {
        warehouseId: text(formData, "warehouseId"),
        medicineId: text(formData, "medicineId"),
        quantity: text(formData, "quantity"),
        reference: text(formData, "reference"),
        notes: text(formData, "notes"),
      },
    });
  } catch (error) {
    return failure(error);
  }
  refresh();
  redirect("/dashboard/warehouse/movements?movementType=dispatch");
}

export async function setBatchStatusAction(_previous, formData) {
  const batchId = text(formData, "batchId");
  try {
    const { batch } = await warehouseApi(`/warehouse/batches/${batchId}`, {
      method: "PATCH",
      body: { status: text(formData, "status"), notes: text(formData, "notes") },
    });
    refresh();
    return { ok: true, message: `Batch status set to ${batch.status}.` };
  } catch (error) {
    return failure(error);
  }
}

// Issues a new label for a batch (the old code stops working).
export async function regenerateQrAction(_previous, formData) {
  try {
    const { qr } = await warehouseApi(`/warehouse/qr/batch/${text(formData, "batchId")}`, { method: "POST" });
    refresh();
    return { ok: true, message: `New label ${qr.displayCode} issued; the previous code is deactivated.` };
  } catch (error) {
    return failure(error);
  }
}

export async function updateThresholdsAction(_previous, formData) {
  try {
    const { warehouse } = await warehouseApi(`/warehouse/warehouses/${text(formData, "warehouseId")}`, {
      method: "PATCH",
      body: {
        nearExpiryDays: text(formData, "nearExpiryDays"),
        criticalExpiryDays: text(formData, "criticalExpiryDays"),
      },
    });
    refresh();
    return {
      ok: true,
      message: `Thresholds saved: critical ≤ ${warehouse.criticalExpiryDays} days, near expiry ≤ ${warehouse.nearExpiryDays} days.`,
    };
  } catch (error) {
    return failure(error);
  }
}
