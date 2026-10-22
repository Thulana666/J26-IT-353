"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UUID_RE, coldChainApi } from "@/lib/cold-chain/api";
import { WarehouseApiError } from "@/lib/warehouse/api";

// Server actions for the cold-chain pages. Form actions return
// { ok: true, message } or { ok: false, error, fields } for the form
// components. The backend validates every value and checks the user's role
// (admins and warehouse staff start monitoring; only admins manage devices).

const FIELD_LABELS = {
  shipmentId: "Shipment",
  deviceId: "Device",
  expectedDeliveryAt: "Expected delivery",
  tempMinC: "Minimum temperature",
  tempMaxC: "Maximum temperature",
  humidityMinPct: "Minimum humidity",
  humidityMaxPct: "Maximum humidity",
  readingIntervalSeconds: "Reading interval",
  isTest: "Test shipment",
  deviceCode: "Device code",
  deviceType: "Device type",
  name: "Name",
  notes: "Notes",
  driverId: "Driver",
  truckId: "Truck",
  fullName: "Full name",
  phone: "Phone",
  email: "Email",
  licenceNumber: "Licence number",
  licenceExpiry: "Licence expiry",
  registrationNumber: "Registration number",
  truckType: "Truck type",
  isRefrigerated: "Refrigerated",
  minTempC: "Minimum temperature",
  maxTempC: "Maximum temperature",
};

function failure(error) {
  if (!(error instanceof WarehouseApiError)) throw error;
  const fields = error.details?.fields
    ? Object.fromEntries(Object.entries(error.details.fields).map(([key, message]) => [FIELD_LABELS[key] ?? key, message]))
    : null;
  return { ok: false, error: error.message, fields };
}

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// A form value that may be cleared: "" -> null (e.g. "no humidity limit").
function nullable(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? (value.trim() === "" ? null : value.trim()) : undefined;
}

// <input type="datetime-local"> has no time zone; the dashboard works in Sri Lanka time (UTC+05:30, no DST).
function sriLankaTime(value) {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+05:30` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) ? `${value}+05:30` : value;
}

function refresh() {
  revalidatePath("/dashboard/cold-chain", "layout");
}

// --- Alerts ------------------------------------------------------------------

export async function acknowledgeAlertAction(_previous, formData) {
  const alertId = formData.get("alertId");
  const shipmentId = formData.get("shipmentId");
  if (typeof alertId !== "string" || !UUID_RE.test(alertId)) return { ok: false, error: "Unknown alert." };
  try {
    await coldChainApi(`/alerts/${alertId}/acknowledge`, { method: "POST" });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(typeof shipmentId === "string" && UUID_RE.test(shipmentId) ? `/dashboard/cold-chain/${shipmentId}` : "/dashboard/cold-chain");
  return { ok: true, message: "Alert acknowledged." };
}

// --- Monitoring ----------------------------------------------------------------

// Starts monitoring an in-transit shipment, then opens its page.
export async function startMonitoringAction(_previous, formData) {
  const shipmentId = text(formData, "shipmentId");
  if (!shipmentId || !UUID_RE.test(shipmentId)) return { ok: false, error: "Choose a shipment." };
  try {
    await coldChainApi("/shipments", {
      method: "POST",
      body: {
        shipmentId,
        deviceId: text(formData, "deviceId"),
        expectedDeliveryAt: sriLankaTime(text(formData, "expectedDeliveryAt")),
        tempMinC: text(formData, "tempMinC"),
        tempMaxC: text(formData, "tempMaxC"),
        humidityMinPct: nullable(formData, "humidityMinPct"),
        humidityMaxPct: nullable(formData, "humidityMaxPct"),
        readingIntervalSeconds: text(formData, "readingIntervalSeconds"),
        isTest: formData.get("isTest") === "true",
      },
    });
  } catch (error) {
    return failure(error);
  }
  refresh();
  redirect(`/dashboard/cold-chain/${shipmentId}`);
}

// --- Devices (admins) -----------------------------------------------------------

// Registers a device. The answer holds its key, which is shown once and never stored.
export async function registerDeviceAction(_previous, formData) {
  let body;
  try {
    body = await coldChainApi("/devices", {
      method: "POST",
      body: {
        deviceCode: text(formData, "deviceCode") ?? "",
        name: text(formData, "name"),
        deviceType: text(formData, "deviceType"),
        notes: text(formData, "notes"),
      },
    });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: `Device ${body.device.deviceCode} registered.`, deviceCode: body.device.deviceCode, deviceKey: body.deviceKey };
}

export async function rotateDeviceKeyAction(_previous, formData) {
  const deviceId = text(formData, "deviceId");
  if (!deviceId || !UUID_RE.test(deviceId)) return { ok: false, error: "Unknown device." };
  let body;
  try {
    body = await coldChainApi(`/devices/${deviceId}/rotate-key`, { method: "POST" });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: "New key issued; the old key no longer works.", deviceCode: body.device.deviceCode, deviceKey: body.deviceKey };
}

export async function setDeviceActiveAction(_previous, formData) {
  const deviceId = text(formData, "deviceId");
  if (!deviceId || !UUID_RE.test(deviceId)) return { ok: false, error: "Unknown device." };
  try {
    await coldChainApi(`/devices/${deviceId}`, { method: "PATCH", body: { isActive: formData.get("isActive") === "true" } });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true };
}

// --- Trip workflow (admins and warehouse staff) ---------------------------------

function tripPath(shipmentId) {
  return `/dashboard/cold-chain/${shipmentId}`;
}

export async function allocateTripAction(_previous, formData) {
  const shipmentId = text(formData, "shipmentId");
  if (!shipmentId || !UUID_RE.test(shipmentId)) return { ok: false, error: "Unknown shipment." };
  try {
    await coldChainApi(`/shipments/${shipmentId}/allocate`, {
      method: "POST",
      body: { driverId: text(formData, "driverId") ?? "", truckId: text(formData, "truckId") ?? "", deviceId: text(formData, "deviceId") },
    });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: "Driver and truck allocated." };
}

export async function startTripAction(_previous, formData) {
  const shipmentId = text(formData, "shipmentId");
  if (!shipmentId || !UUID_RE.test(shipmentId)) return { ok: false, error: "Unknown shipment." };
  try {
    await coldChainApi(`/shipments/${shipmentId}/start`, { method: "POST" });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(tripPath(shipmentId));
  refresh();
  return { ok: true, message: "Trip started: the shipment is in transit." };
}

// --- Drivers and trucks (admins and warehouse staff) ----------------------------

// Creates a driver, or updates one when the form carries an id.
export async function saveDriverAction(_previous, formData) {
  const driverId = text(formData, "driverId");
  const body = {
    fullName: text(formData, "fullName") ?? "",
    phone: text(formData, "phone") ?? "",
    email: nullable(formData, "email"),
    licenceNumber: text(formData, "licenceNumber") ?? "",
    licenceExpiry: text(formData, "licenceExpiry") ?? "",
    notes: nullable(formData, "notes"),
  };
  try {
    if (driverId) await coldChainApi(`/drivers/${driverId}`, { method: "PATCH", body });
    else await coldChainApi("/drivers", { method: "POST", body });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: driverId ? "Driver updated." : `Driver ${body.fullName} added.` };
}

export async function setDriverStatusAction(_previous, formData) {
  const driverId = text(formData, "driverId");
  if (!driverId || !UUID_RE.test(driverId)) return { ok: false, error: "Unknown driver." };
  try {
    await coldChainApi(`/drivers/${driverId}/status`, { method: "PATCH", body: { active: formData.get("active") === "true" } });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true };
}

// Creates a truck, or updates one when the form carries an id.
export async function saveTruckAction(_previous, formData) {
  const truckId = text(formData, "truckId");
  const isRefrigerated = formData.get("isRefrigerated") === "true";
  const body = {
    registrationNumber: text(formData, "registrationNumber") ?? "",
    truckType: text(formData, "truckType") ?? "",
    isRefrigerated,
    minTempC: isRefrigerated ? nullable(formData, "minTempC") : null,
    maxTempC: isRefrigerated ? nullable(formData, "maxTempC") : null,
    deviceId: nullable(formData, "deviceId"),
    notes: nullable(formData, "notes"),
  };
  try {
    if (truckId) await coldChainApi(`/trucks/${truckId}`, { method: "PATCH", body });
    else await coldChainApi("/trucks", { method: "POST", body });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: truckId ? "Truck updated." : `Truck ${body.registrationNumber.toUpperCase()} added.` };
}

export async function setTruckStatusAction(_previous, formData) {
  const truckId = text(formData, "truckId");
  if (!truckId || !UUID_RE.test(truckId)) return { ok: false, error: "Unknown truck." };
  try {
    await coldChainApi(`/trucks/${truckId}/status`, { method: "PATCH", body: { active: formData.get("active") === "true" } });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true };
}

// --- Driver accounts and issues (admins and warehouse staff) --------------------

export async function linkDriverAccountAction(_previous, formData) {
  const driverId = text(formData, "driverId");
  if (!driverId || !UUID_RE.test(driverId)) return { ok: false, error: "Unknown driver." };
  try {
    await coldChainApi(`/drivers/${driverId}/account`, { method: "POST", body: { email: text(formData, "email") ?? "" } });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true, message: "Account linked: the driver can sign in to the Driver Portal." };
}

export async function unlinkDriverAccountAction(_previous, formData) {
  const driverId = text(formData, "driverId");
  if (!driverId || !UUID_RE.test(driverId)) return { ok: false, error: "Unknown driver." };
  try {
    await coldChainApi(`/drivers/${driverId}/account`, { method: "DELETE" });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true };
}

export async function setIssueStatusAction(_previous, formData) {
  const issueId = text(formData, "issueId");
  if (!issueId || !UUID_RE.test(issueId)) return { ok: false, error: "Unknown issue." };
  try {
    await coldChainApi(`/issues/${issueId}`, { method: "PATCH", body: { status: text(formData, "status") ?? "" } });
  } catch (error) {
    return failure(error);
  }
  refresh();
  return { ok: true };
}
