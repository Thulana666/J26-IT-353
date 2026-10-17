"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { PHARMACY_COOKIE, PharmacyApiError, pharmacyApi } from "@/lib/pharmacy/api";

// Server actions for the pharmacy pages. Form actions return
// { ok: true, message } or { ok: false, error, fields } for <ActionForm>;
// actions called from client components with an object return data the same
// way. The backend validates every value and checks roles and pharmacy
// ownership; these only pass values on. Prices and totals are never sent.

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Optional field that may be cleared: "" -> null.
function nullable(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : undefined;
}

function failure(error) {
  if (!(error instanceof PharmacyApiError)) throw error;
  return { ok: false, error: error.message, fields: error.details?.fields ?? null };
}

function refresh() {
  revalidatePath("/dashboard/pharmacy", "layout");
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// --- Context -------------------------------------------------------------------

// Admins: the pharmacy to work in (validated by the backend on every request).
export async function selectPharmacyAction(pharmacyId) {
  const store = await cookies();
  if (typeof pharmacyId === "string" && /^[0-9a-f-]{36}$/i.test(pharmacyId)) {
    store.set(PHARMACY_COOKIE, pharmacyId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 180 });
  } else {
    store.delete(PHARMACY_COOKIE);
  }
  refresh();
  return { ok: true };
}

// Barcode / batch number / warehouse QR / name -> product and FEFO batches.
// medicineId picks a product directly (from name-search matches).
export async function lookupCodeAction(code, medicineId) {
  try {
    return { ok: true, result: await pharmacyApi("/pharmacy/inventory/lookup", { query: { code, medicineId } }) };
  } catch (error) {
    return failure(error);
  }
}

// --- Sales ---------------------------------------------------------------------

// { clientRequestId, items: [{ batchId, quantity }], discountPercent, paymentMethod, amountTendered, ... }
export async function checkoutAction(payload) {
  try {
    const { sale } = await pharmacyApi("/pharmacy/sales", { method: "POST", body: payload });
    refresh();
    return { ok: true, sale };
  } catch (error) {
    return failure(error);
  }
}

// --- Receiving and discrepancies ---------------------------------------------------

// Confirm Receipt after physical inspection. Sends no quantities: the
// database uses the shipped quantities and the warehouse's batch details.
// { acceptPartial: true } accepts only items without a discrepancy report.
export async function receiveShipmentAction(shipmentId, payload = {}) {
  try {
    const { result } = await pharmacyApi(`/pharmacy/shipments/${shipmentId}/receive`, {
      method: "POST",
      body: { acceptPartial: payload.acceptPartial === true, notes: payload.notes },
    });
    refresh();
    let message;
    if (result.alreadyProcessed) {
      message = `Shipment ${result.shipmentNumber} was already received. Nothing was added again.`;
    } else if (result.itemsHeld > 0) {
      message = `Receipt recorded: ${plural(result.itemsAccepted, "item")} added to stock (${result.unitsAdded} units); ${plural(result.itemsHeld, "disputed item")} held out of stock until the warehouse resolves the reports.`;
    } else {
      message = `Receipt confirmed: ${plural(result.itemsAccepted, "item")} added to stock (${result.unitsAdded} units).`;
    }
    return { ok: true, result, message };
  } catch (error) {
    return failure(error);
  }
}

// Accept a held (disputed) item after the warehouse resolved its reports.
export async function acceptHeldItemAction(_previous, formData) {
  try {
    const { result } = await pharmacyApi(
      `/pharmacy/shipments/${text(formData, "shipmentId")}/items/${text(formData, "itemId")}/accept`,
      { method: "POST", body: { quantity: text(formData, "quantity"), notes: text(formData, "notes") } }
    );
    refresh();
    return {
      ok: true,
      message: result.alreadyProcessed
        ? "This item was already accepted. Nothing was added again."
        : `${plural(result.quantityAccepted, "verified pack")} accepted (${result.unitsAdded} units added to stock).`,
    };
  } catch (error) {
    return failure(error);
  }
}

// { clientRequestId, shipmentId, shipmentItemId?, medicineId?, type, observedQuantity, notes, barcode? }
// The same clientRequestId returns the first report instead of a duplicate.
export async function reportDiscrepancyAction(payload) {
  try {
    const report = await pharmacyApi("/pharmacy/discrepancies", { method: "POST", body: payload });
    refresh();
    return {
      ok: true,
      report,
      message: report.duplicate
        ? `Report ${report.reportNumber} was already recorded; no duplicate was created.`
        : report.heldUnits > 0
          ? `Discrepancy report ${report.reportNumber} recorded and sent to the warehouse. ${report.heldUnits} unit(s) already in stock are held (not sellable) until the warehouse resolves it.`
          : `Discrepancy report ${report.reportNumber} recorded and sent to the warehouse. The disputed quantity is not added to stock.`,
    };
  } catch (error) {
    return failure(error);
  }
}

// After the warehouse resolved a report: release its held units or write them off.
export async function settleDiscrepancyHoldAction(_previous, formData) {
  try {
    const outcome = text(formData, "outcome") === "write_off" ? "write_off" : "release";
    const { result } = await pharmacyApi(`/pharmacy/discrepancies/${text(formData, "discrepancyId")}/hold`, {
      method: "POST",
      body: { outcome, notes: text(formData, "notes") },
    });
    refresh();
    return {
      ok: true,
      message: result.alreadyProcessed
        ? "This hold was already settled. Nothing changed."
        : outcome === "release"
          ? `${plural(result.units, "unit")} released to available stock.`
          : `${plural(result.units, "unit")} written off.`,
    };
  } catch (error) {
    return failure(error);
  }
}

// --- Orders --------------------------------------------------------------------

// { items: [{ medicineId, quantity, recommendationId? }], notes }
export async function createOrderAction(payload) {
  try {
    const { order } = await pharmacyApi("/pharmacy/orders", { method: "POST", body: payload });
    refresh();
    return { ok: true, order, message: `Order ${order.orderNumber} sent to the warehouse.` };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelOrderAction(_previous, formData) {
  try {
    const { order } = await pharmacyApi(`/pharmacy/orders/${text(formData, "orderId")}/cancel`, {
      method: "POST",
      body: { reason: text(formData, "reason") },
    });
    refresh();
    return { ok: true, message: `Order ${order.orderNumber} cancelled.` };
  } catch (error) {
    return failure(error);
  }
}

// --- Returns -------------------------------------------------------------------

// { items: [{ inventoryId, quantity, reason, notes }], notes }
export async function createReturnAction(payload) {
  try {
    const { returnNumber } = await pharmacyApi("/pharmacy/returns", { method: "POST", body: payload });
    refresh();
    return { ok: true, message: `Return ${returnNumber} sent to the warehouse. The stock is held until they receive it.` };
  } catch (error) {
    return failure(error);
  }
}

// --- Analytics, recommendations, alerts ------------------------------------------

export async function runForecastAction() {
  try {
    const { run } = await pharmacyApi("/pharmacy/analytics/run", { method: "POST", timeoutMs: 180_000 });
    refresh();
    return { ok: true, message: `Moving-average estimates and reorder recommendations updated for ${plural(run.productCount ?? 0, "product")}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function rejectRecommendationAction(_previous, formData) {
  try {
    await pharmacyApi(`/pharmacy/recommendations/${text(formData, "recommendationId")}/reject`, {
      method: "POST",
      body: { notes: text(formData, "notes") },
    });
    refresh();
    return { ok: true, message: "Recommendation rejected and recorded." };
  } catch (error) {
    return failure(error);
  }
}

export async function alertAction(_previous, formData) {
  const action = text(formData, "action") === "resolve" ? "resolve" : "acknowledge";
  try {
    await pharmacyApi(`/pharmacy/alerts/${text(formData, "alertId")}/${action}`, { method: "POST" });
    refresh();
    return { ok: true, message: action === "resolve" ? "Alert closed." : "Alert acknowledged." };
  } catch (error) {
    return failure(error);
  }
}

export async function refreshAlertsAction() {
  try {
    const result = await pharmacyApi("/pharmacy/alerts/refresh", { method: "POST" });
    refresh();
    return { ok: true, message: `${plural(result.open, "active alert")}, ${result.resolved} cleared.` };
  } catch (error) {
    return failure(error);
  }
}

// --- Stock ---------------------------------------------------------------------

export async function adjustStockAction(_previous, formData) {
  try {
    const result = await pharmacyApi("/pharmacy/inventory/adjust", {
      method: "POST",
      body: { batchId: text(formData, "batchId"), change: text(formData, "change"), reason: text(formData, "reason") },
    });
    refresh();
    return { ok: true, message: `Stock adjusted; ${result.quantityOnHand} on hand.` };
  } catch (error) {
    return failure(error);
  }
}

// --- Settings ------------------------------------------------------------------

export async function updateDefaultsAction(_previous, formData) {
  try {
    await pharmacyApi("/pharmacy/settings/defaults", {
      method: "PATCH",
      body: {
        defaultLeadTimeDays: text(formData, "defaultLeadTimeDays"),
        defaultReviewPeriodDays: text(formData, "defaultReviewPeriodDays"),
        defaultServiceLevel: text(formData, "defaultServiceLevel"),
        burnRateWindowDays: text(formData, "burnRateWindowDays"),
        nearExpiryDays: text(formData, "nearExpiryDays"),
      },
    });
    refresh();
    return { ok: true, message: "Defaults saved. Recalculate recommendations to apply them." };
  } catch (error) {
    return failure(error);
  }
}

export async function updateProfileAction(_previous, formData) {
  try {
    await pharmacyApi("/pharmacy/settings/profile", {
      method: "PATCH",
      body: {
        name: text(formData, "name"),
        address: nullable(formData, "address"),
        phone: nullable(formData, "phone"),
        licenseNumber: nullable(formData, "licenseNumber"),
        warehouseId: nullable(formData, "warehouseId"),
        taxRatePercent: text(formData, "taxRatePercent"),
        maxDiscountPercent: text(formData, "maxDiscountPercent"),
        isActive: formData.get("isActive") === "on",
      },
    });
    refresh();
    return { ok: true, message: "Pharmacy profile saved." };
  } catch (error) {
    return failure(error);
  }
}

export async function saveReorderSettingsAction(_previous, formData) {
  const medicineId = text(formData, "medicineId");
  try {
    if (formData.get("intent") === "reset") {
      await pharmacyApi(`/pharmacy/settings/reorder/${medicineId}`, { method: "DELETE" });
      refresh();
      return { ok: true, message: "Back to the pharmacy defaults." };
    }
    await pharmacyApi(`/pharmacy/settings/reorder/${medicineId}`, {
      method: "PUT",
      body: {
        leadTimeDays: nullable(formData, "leadTimeDays"),
        reviewPeriodDays: nullable(formData, "reviewPeriodDays"),
        safetyStockMethod: text(formData, "safetyStockMethod"),
        serviceLevel: nullable(formData, "serviceLevel"),
        safetyStockDays: nullable(formData, "safetyStockDays"),
        safetyStockUnits: nullable(formData, "safetyStockUnits"),
        lowStockThreshold: nullable(formData, "lowStockThreshold"),
        minOrderPacks: text(formData, "minOrderPacks") ?? "1",
        maxStockUnits: nullable(formData, "maxStockUnits"),
        isActive: formData.get("isActive") === "on",
      },
    });
    refresh();
    return { ok: true, message: "Reorder settings saved." };
  } catch (error) {
    return failure(error);
  }
}

// --- Admin ---------------------------------------------------------------------

export async function updateUserAction(_previous, formData) {
  try {
    const { user } = await pharmacyApi(`/pharmacy/admin/users/${text(formData, "userId")}`, {
      method: "PATCH",
      body: { role: text(formData, "role"), status: text(formData, "status"), pharmacyId: nullable(formData, "pharmacyId") },
    });
    refresh();
    return { ok: true, message: `${user.email} updated.` };
  } catch (error) {
    return failure(error);
  }
}

export async function createPharmacyAction(_previous, formData) {
  try {
    const { pharmacy } = await pharmacyApi("/pharmacy/admin/pharmacies", {
      method: "POST",
      body: {
        code: text(formData, "code")?.toUpperCase(),
        name: text(formData, "name"),
        warehouseId: nullable(formData, "warehouseId"),
        address: text(formData, "address"),
        phone: text(formData, "phone"),
        licenseNumber: text(formData, "licenseNumber"),
      },
    });
    refresh();
    return { ok: true, message: `Pharmacy ${pharmacy.code} created.` };
  } catch (error) {
    return failure(error);
  }
}

export async function updateProductAction(_previous, formData) {
  try {
    await pharmacyApi(`/pharmacy/admin/products/${text(formData, "medicineId")}`, {
      method: "PATCH",
      body: {
        brandName: text(formData, "brandName"),
        manufacturer: text(formData, "manufacturer"),
        dispensingUnit: text(formData, "dispensingUnit"),
        unitsPerPack: text(formData, "unitsPerPack"),
        unitCost: nullable(formData, "unitCost"),
        retailPrice: nullable(formData, "retailPrice"),
      },
    });
    refresh();
    return { ok: true, message: "Product saved. New prices apply to stock delivered from now on." };
  } catch (error) {
    return failure(error);
  }
}

export async function addBarcodeAction(_previous, formData) {
  try {
    await pharmacyApi(`/pharmacy/admin/products/${text(formData, "medicineId")}/barcodes`, {
      method: "POST",
      body: {
        barcode: text(formData, "barcode"),
        symbology: text(formData, "symbology"),
        packagingLevel: text(formData, "packagingLevel"),
      },
    });
    refresh();
    return { ok: true, message: "Barcode added." };
  } catch (error) {
    return failure(error);
  }
}

export async function removeBarcodeAction(_previous, formData) {
  try {
    await pharmacyApi(`/pharmacy/admin/barcodes/${text(formData, "barcodeId")}`, { method: "DELETE" });
    refresh();
    return { ok: true, message: "Barcode removed." };
  } catch (error) {
    return failure(error);
  }
}
