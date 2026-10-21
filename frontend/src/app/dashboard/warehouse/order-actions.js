"use server";

import { warehouseApi } from "@/lib/warehouse/api";
import { checked, failure, plural, refreshWarehouse, text } from "@/lib/warehouse/action-helpers";

// Server actions for pharmacy order fulfilment, discrepancy reports, returns
// and integration handoffs. The backend validates and authorises everything.

const orderPath = (formData, suffix) => `/warehouse/orders/${text(formData, "orderId")}${suffix}`;

export async function allocateOrderAction(_previous, formData) {
  // Per-item quantities: fields named "qty:<orderItemId>".
  const items = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("qty:")) items.push({ orderItemId: key.slice(4), quantity: String(value).trim() || "0" });
  }
  try {
    await warehouseApi(orderPath(formData, "/allocate"), {
      method: "POST",
      body: {
        items: items.length ? items : undefined,
        minShelfDays: text(formData, "minShelfDays"),
        notes: text(formData, "notes"),
      },
    });
    refreshWarehouse();
    return { ok: true, message: "Stock reserved in FEFO order. Pick each line and confirm it at the shelf." };
  } catch (error) {
    return failure(error);
  }
}

export async function confirmPickAction(_previous, formData) {
  try {
    const { pick } = await warehouseApi(orderPath(formData, `/picks/${text(formData, "pickId")}/confirm`), {
      method: "POST",
      body: { batchCode: text(formData, "batchCode"), locationCode: text(formData, "locationCode") },
    });
    refreshWarehouse();
    return { ok: true, message: pick.pickedVia === "qr_scan" ? "Pick verified by QR scan." : "Pick verified by batch number." };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelAllocationAction(_previous, formData) {
  try {
    await warehouseApi(orderPath(formData, "/cancel-allocation"), { method: "POST", body: { reason: text(formData, "reason") } });
    refreshWarehouse();
    return { ok: true, message: "Allocation cancelled; the reserved stock is available again." };
  } catch (error) {
    return failure(error);
  }
}

export async function dispatchOrderAction(_previous, formData) {
  const expected = text(formData, "expectedDeliveryAt");
  const monitor = checked(formData, "monitorColdChain");
  try {
    const { shipment, integrations } = await warehouseApi(orderPath(formData, "/dispatch"), {
      method: "POST",
      body: {
        notes: text(formData, "notes"),
        coldChain: {
          monitor,
          // datetime-local is entered in Sri Lanka time (the warehouse's zone).
          expectedDeliveryAt: expected ? `${expected}:00+05:30` : undefined,
        },
      },
    });
    refreshWarehouse();
    const handoff = integrations?.[0];
    const coldChain = !monitor
      ? " Set up cold-chain monitoring in Cold Chain → Start monitoring."
      : handoff?.status === "sent"
        ? " Handed over to cold-chain monitoring."
        : ` Cold-chain handoff failed (${handoff?.lastError ?? "unknown error"}); retry it below.`;
    return { ok: true, message: `Dispatched as ${shipment.shipmentNumber}.${coldChain}` };
  } catch (error) {
    return failure(error);
  }
}

export async function declineOrderAction(_previous, formData) {
  try {
    const { order } = await warehouseApi(orderPath(formData, "/decline"), { method: "POST", body: { reason: text(formData, "reason") } });
    refreshWarehouse();
    return { ok: true, message: `Order ${order.orderNumber} declined; the pharmacy sees it as cancelled.` };
  } catch (error) {
    return failure(error);
  }
}

export async function retryHandoffAction(_previous, formData) {
  try {
    const { event } = await warehouseApi(`/warehouse/integrations/${text(formData, "eventId")}/retry`, { method: "POST" });
    refreshWarehouse();
    return event.status === "sent"
      ? { ok: true, message: "Handed over to cold-chain monitoring." }
      : { ok: false, error: `Still failing: ${event.lastError}` };
  } catch (error) {
    return failure(error);
  }
}

export async function updateDiscrepancyAction(_previous, formData) {
  const action = text(formData, "action") === "resolve" ? "resolve" : "acknowledge";
  try {
    const { discrepancy } = await warehouseApi(`/warehouse/discrepancies/${text(formData, "discrepancyId")}/${action}`, {
      method: "POST",
      body: { notes: text(formData, "notes") },
    });
    refreshWarehouse();
    return { ok: true, message: `Report ${discrepancy.reportNumber} ${discrepancy.status}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function reviewReturnAction(_previous, formData) {
  try {
    const { return: row } = await warehouseApi(`/warehouse/returns/${text(formData, "returnId")}/review`, {
      method: "POST",
      body: { decision: text(formData, "decision"), notes: text(formData, "notes") },
    });
    refreshWarehouse();
    return { ok: true, message: `Return ${row.returnNumber} ${row.status}.` };
  } catch (error) {
    return failure(error);
  }
}

export async function receiveReturnAction(_previous, formData) {
  // Restock locations: fields named "restock:<returnItemId>".
  const restock = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("restock:") && String(value)) restock.push({ returnItemId: key.slice(8), locationId: String(value) });
  }
  try {
    const { return: row } = await warehouseApi(`/warehouse/returns/${text(formData, "returnId")}/receive`, {
      method: "POST",
      body: { restock, notes: text(formData, "notes") },
    });
    refreshWarehouse();
    return {
      ok: true,
      message: `Return ${row.returnNumber} received${restock.length ? `; ${plural(restock.length, "item")} restocked` : ""}.`,
    };
  } catch (error) {
    return failure(error);
  }
}
