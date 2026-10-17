// Labels and formatting for the cold-chain pages (Component 2).

export { formatDateTime } from "@/lib/pharmacy/format";
export { SHIPMENT_STATUS } from "@/lib/pharmacy/format";
export { STORAGE_LABELS } from "@/lib/warehouse/format";

export const TIME_ZONE = "Asia/Colombo";

const one = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const isSet = (value) => value !== null && value !== undefined;

export const formatTemp = (value) => (isSet(value) ? `${one.format(value)} °C` : "—");
export const formatHumidity = (value) => (isSet(value) ? `${one.format(value)} %RH` : "—");
export const formatSpeed = (value) => (isSet(value) ? `${one.format(value)} km/h` : "—");
export const formatCoordinate = (value) => (isSet(value) ? value.toFixed(5) : "—");
export const formatPercent = (probability) => (isSet(probability) ? `${Math.round(probability * 100)}%` : "—");

export function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });
}

// 45 -> "45 min", 135 -> "2 h 15 min", 3000 -> "2 d 2 h".
export function formatDuration(value) {
  if (!isSet(value)) return "—";
  const minutes = Math.round(value);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export function formatAge(seconds) {
  if (!isSet(seconds)) return "no readings yet";
  if (seconds < 60) return `${seconds} s ago`;
  return `${formatDuration(seconds / 60)} ago`;
}

// "15–30 °C", "≤ 65 %RH", "≥ 20 %RH", "not set".
export function rangeLabel(min, max, unit) {
  if (isSet(min) && isSet(max)) return `${one.format(min)}–${one.format(max)} ${unit}`;
  if (isSet(max)) return `≤ ${one.format(max)} ${unit}`;
  if (isSet(min)) return `≥ ${one.format(min)} ${unit}`;
  return "not set";
}

// Where a measurement sits against its limits: "above", "below", "ok" or null (not measured).
export function limitState(value, min, max) {
  if (!isSet(value)) return null;
  if (isSet(max) && value > max) return "above";
  if (isSet(min) && value < min) return "below";
  return "ok";
}

// [label, tone]; tones map to components/cold-chain/badges.jsx.
export const CONNECTION = {
  online: ["Online", "green"],
  delayed: ["Delayed", "amber"],
  offline: ["Offline", "red"],
  no_data: ["No data yet", "gray"],
  ended: ["Monitoring ended", "gray"],
};

export const LIMIT_STATE = {
  ok: ["Within limits", "green"],
  above: ["Above limit", "red"],
  below: ["Below limit", "red"],
};

export const ALERT_STATUS = {
  open: ["Open", "red"],
  acknowledged: ["Acknowledged", "amber"],
  resolved: ["Resolved", "gray"],
};

export const RISK_TYPES = {
  temperature_excursion: "Temperature excursion",
  humidity_deviation: "Humidity deviation",
  delivery_delay: "Delivery delay",
  route_anomaly: "Route / logistics anomaly",
  communication_gap: "Communication gap",
  combined: "Combined cold-chain risk",
};

export const QUALITY_FLAGS = {
  delayed_upload: ["Delayed upload", "Received more than 5 minutes (or 3 reading intervals) after it was recorded."],
  gps_jump: ["GPS jump", "The position moved implausibly fast since the previous fix; the value is stored as sent."],
  after_delivery: ["After delivery", "Recorded after the pharmacy received the shipment."],
};
