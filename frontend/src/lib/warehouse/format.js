// Labels and formatting for the warehouse pages (Component 3).

export const EXPIRY_LABELS = {
  expired: "Expired",
  critical: "Critical",
  near_expiry: "Near expiry",
  ok: "OK",
};

export const MOVEMENT_LABELS = {
  receive: "Receive",
  transfer: "Transfer",
  dispatch: "Dispatch",
  adjustment: "Adjustment",
  disposal: "Disposal",
};

export const STORAGE_LABELS = {
  ambient: "Ambient 15–30 °C",
  cool: "Cool 8–15 °C",
  refrigerated: "Refrigerated 2–8 °C",
  frozen: "Frozen ≤ −15 °C",
};

export const VIA_LABELS = { manual: "Form", qr_scan: "QR scan", system: "System" };

const FIELD_LABELS = {
  batchId: "Batch",
  medicineId: "Medicine",
  batchNumber: "Batch number",
  manufacturingDate: "Manufacturing date",
  expiryDate: "Expiry date",
  quantity: "Quantity",
  fromLocationId: "Source location",
  toLocationId: "Destination",
  warehouseId: "Warehouse",
  notes: "Reason / notes",
  reference: "Reference",
  fefoOverrideReason: "FEFO override reason",
  nearExpiryDays: "Near-expiry threshold",
  criticalExpiryDays: "Critical threshold",
  status: "Status",
};

export function fieldLabel(field) {
  return FIELD_LABELS[field] ?? field;
}

export function medicineLabel({ name, medicineName, strength }) {
  const base = name ?? medicineName ?? "Unknown medicine";
  return strength ? `${base} ${strength}` : base;
}

export function daysLabel(days) {
  if (days < 0) return `expired ${-days} d ago`;
  if (days === 0) return "expires today";
  return `${days} d left`;
}

export function formatDateTime(value) {
  return new Date(value).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "SAMPLE-CMB · A · A01-L2-P1"
export function locationPath({ warehouseCode, zoneCode, code, locationCode }) {
  return [warehouseCode, zoneCode, code ?? locationCode].filter(Boolean).join(" · ");
}
