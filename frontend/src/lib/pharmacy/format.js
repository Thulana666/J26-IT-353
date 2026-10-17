// Labels and formatting for the pharmacy pages (Component 4).

export const CURRENCY = "LKR";

const moneyFormat = new Intl.NumberFormat("en-LK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export const formatMoney = (value) => (value === null || value === undefined ? "—" : `${CURRENCY} ${moneyFormat.format(value)}`);
export const formatQty = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
export const formatNum = (value) => (value === null || value === undefined ? "—" : numberFormat.format(value));
export const formatPct = (value, digits = 1) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;

export function formatDate(value) {
  if (!value) return "—";
  const date = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Colombo",
  });
}

export function productLabel(product) {
  if (!product) return "Unknown product";
  return [product.name, product.strength].filter(Boolean).join(" ");
}

// "strip of 10 tablets" -> "strips" (matches the backend's unit labels).
export function unitLabel(product) {
  if (!product?.dispensingUnit) return "units";
  const word = product.dispensingUnit.split(/\s+of\s+|\(/)[0].trim().split(/\s+/).pop();
  return word.endsWith("s") ? word : `${word}s`;
}

// "carton of 10 strips"; just the pack unit when a pack is one unit.
export function packagingLabel(product) {
  if (!product?.packUnit) return null;
  const perPack = product.unitsPerPack ?? 1;
  return perPack > 1 ? `${product.packUnit} of ${formatNum(perPack)} ${unitLabel(product)}` : product.packUnit;
}

export function packLabel(product, count = 2) {
  const unit = product?.packUnit ?? "pack";
  return count === 1 ? unit : `${unit}s`;
}

// Packs -> "3 cartons (300 strips)".
export function packsAndUnits(packs, product) {
  const units = packs * (product?.unitsPerPack ?? 1);
  return `${formatNum(packs)} ${packLabel(product, packs)} (${formatNum(units)} ${unitLabel(product)})`;
}

// [label, tone]; tones map to badge colours in components/pharmacy/badges.jsx.
export const ORDER_STATUS = {
  submitted: ["Submitted", "blue"],
  dispatched: ["Dispatched", "amber"],
  received: ["Received", "green"],
  cancelled: ["Cancelled", "gray"],
};
export const SHIPMENT_STATUS = {
  in_transit: ["In transit", "amber"],
  received: ["Received", "green"],
  received_with_discrepancies: ["Received with discrepancies", "red"],
};
export const ITEM_VERIFICATION = {
  pending: ["Awaiting inspection", "gray"],
  matched: ["Received", "green"],
  discrepancy: ["Disputed", "red"],
};

// Item status on the Receiving page (verification status + acceptance).
export function itemState(item) {
  if (item.verificationStatus === "matched") return ["Received", "green"];
  if (item.verificationStatus === "discrepancy") {
    return item.acceptedAt ? ["Accepted after resolution", "blue"] : ["Disputed · held out of stock", "red"];
  }
  return ["Awaiting inspection", "gray"];
}
export const DISCREPANCY_STATUS = {
  open: ["Open", "red"],
  acknowledged: ["Acknowledged", "amber"],
  resolved: ["Resolved", "green"],
};
export const DISCREPANCY_TYPES = {
  missing: "Missing",
  excess: "Excess",
  damaged: "Damaged",
  incorrect_item: "Incorrect item",
  incorrect_batch: "Incorrect batch",
  expired: "Expired",
  other: "Other",
};

// Types staff choose when reporting a disputed shipment item, and what the
// observed quantity means for each.
export const REPORT_TYPES = {
  missing: { label: "Missing", observed: "Packs actually delivered (fewer than shipped)" },
  excess: { label: "Excess", observed: "Packs actually delivered (more than shipped)" },
  damaged: { label: "Damaged", observed: "Damaged packs" },
  incorrect_item: { label: "Incorrect item", observed: "Incorrect packs delivered" },
  incorrect_batch: { label: "Incorrect batch", observed: "Packs with a different batch" },
};
export const RETURN_STATUS = {
  pending: ["Pending", "blue"],
  approved: ["Approved", "amber"],
  rejected: ["Rejected", "gray"],
  received: ["Received", "green"],
};
export const RETURN_REASONS = {
  expired: "Expired",
  near_expiry: "Near expiry",
  damaged: "Damaged",
  recalled: "Recalled",
  overstock: "Overstock",
  incorrect_item: "Incorrect item",
  other: "Other",
};
export const EXPIRY_STATUS = {
  expired: ["Expired", "red"],
  critical: ["≤ 30 days", "red"],
  near_expiry: ["Near expiry", "amber"],
  ok: ["OK", "green"],
};
export const STOCK_STATUS = {
  out: ["Out of stock", "red"],
  low: ["Low", "amber"],
  ok: ["In stock", "green"],
};
export const RISK = {
  high: ["High", "red"],
  medium: ["Medium", "amber"],
  low: ["Low", "blue"],
  none: ["None", "green"],
};
export const RECOMMENDATION_STATUS = {
  pending: ["Pending", "blue"],
  accepted: ["Accepted", "green"],
  edited: ["Edited", "amber"],
  rejected: ["Rejected", "gray"],
  superseded: ["Superseded", "gray"],
};
export const ALERT_TYPES = {
  low_stock: "Low stock",
  reorder: "Reorder",
  predicted_stockout: "Predicted stockout",
  near_expiry: "Near expiry",
  expired: "Expired",
  unusual_consumption: "Unusual consumption",
};
export const SEVERITY = {
  critical: ["Critical", "red"],
  warning: ["Warning", "amber"],
  info: ["Info", "blue"],
};
export const MOVEMENT_TYPES = {
  opening_balance: "Opening balance",
  receipt: "Receipt",
  sale: "Sale",
  return_reserve: "Held for return",
  return_release: "Return released",
  return_dispatch: "Returned to warehouse",
  adjustment: "Adjustment",
  discrepancy_hold: "Held (discrepancy)",
  discrepancy_release: "Released (discrepancy resolved)",
  discrepancy_write_off: "Written off (discrepancy)",
};
export const MODELS = {
  moving_average: "Moving average",
  random_forest: "Random Forest (earlier run)",
  xgboost: "XGBoost (earlier run)",
};

export const BURN_STATUS = {
  ok: ["OK", "green"],
  no_sales: ["No sales in window", "gray"],
  insufficient_history: ["Insufficient history", "amber"],
  no_history: ["No history", "gray"],
};

// Days of stock cover, never infinite or invented.
export function coverLabel(cover) {
  if (!cover) return "—";
  if (cover.status === "out_of_stock") return "Out of stock";
  if (cover.status === "no_sales") return "No recent sales";
  if (cover.status === "no_history") return "No sales history";
  return `${formatQty(cover.days)} days${cover.provisional ? " (provisional)" : ""}`;
}
export const PAYMENT_METHODS = { cash: "Cash", card: "Card", mobile: "Mobile payment", other: "Other" };
export const ROLES = {
  admin: "Admin",
  pharmacy_staff: "Pharmacy staff",
  warehouse_staff: "Warehouse staff",
  user: "User (no pharmacy access)",
};
export const SAFETY_METHODS = {
  service_level: "Service level (z × σ × √(L+R))",
  days_of_cover: "Days of cover",
  fixed_units: "Fixed units",
};

const FIELD_LABELS = {
  items: "Items",
  quantity: "Quantity",
  quantityReceived: "Received quantity",
  quantityDamaged: "Damaged quantity",
  amountTendered: "Cash received",
  discountPercent: "Discount",
  paymentMethod: "Payment method",
  notes: "Notes",
  reason: "Reason",
  pharmacyId: "Pharmacy",
  safetyStockDays: "Safety stock days",
  safetyStockUnits: "Safety stock units",
  observedQuantity: "Observed quantity",
  clientRequestId: "Request id",
};

// "items.0.quantity" -> "Item 1 quantity"
export function fieldLabel(field) {
  const match = /^(\w+)\.(\d+)\.(\w+)$/.exec(field);
  if (match) return `${FIELD_LABELS[match[1]]?.replace(/s$/, "") ?? match[1]} ${Number(match[2]) + 1} ${FIELD_LABELS[match[3]]?.toLowerCase() ?? match[3]}`;
  return FIELD_LABELS[field] ?? field;
}
