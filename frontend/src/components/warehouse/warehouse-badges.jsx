import { Badge } from "@/components/ui/badge";
import {
  EXPIRY_LABELS,
  MOVEMENT_LABELS,
  ORDER_STAGE_LABELS,
  PICK_STATUS_LABELS,
  SCAN_RESULT_LABELS,
  STORAGE_LABELS,
  daysLabel,
} from "@/lib/warehouse/format";
import styles from "./warehouse.module.css";

const TONES = {
  red: styles.toneRed,
  orange: styles.toneOrange,
  amber: styles.toneAmber,
  green: styles.toneGreen,
  sky: styles.toneSky,
  violet: styles.toneViolet,
  neutral: styles.toneNeutral,
};

function ToneBadge({ tone, title, children }) {
  return (
    <Badge variant="secondary" className={TONES[tone]} title={title}>
      {children}
    </Badge>
  );
}

const EXPIRY_TONES = { expired: "red", critical: "orange", near_expiry: "amber", ok: "green" };

// expiry = { status, daysToExpiry } from the API.
export function ExpiryBadge({ expiry, showDays = false }) {
  if (!expiry) return null;
  return (
    <ToneBadge tone={EXPIRY_TONES[expiry.status]} title={daysLabel(expiry.daysToExpiry)}>
      {EXPIRY_LABELS[expiry.status]}
      {showDays && ` · ${daysLabel(expiry.daysToExpiry)}`}
    </ToneBadge>
  );
}

const BATCH_TONES = { active: "green", quarantined: "amber", recalled: "red", disposed: "neutral" };

export function BatchStatusBadge({ status }) {
  return (
    <ToneBadge tone={BATCH_TONES[status] ?? "neutral"}>
      <span className={styles.capitalize}>{status}</span>
    </ToneBadge>
  );
}

const MOVEMENT_TONES = { receive: "green", transfer: "sky", dispatch: "violet", adjustment: "amber", disposal: "red" };

export function MovementBadge({ type }) {
  return <ToneBadge tone={MOVEMENT_TONES[type] ?? "neutral"}>{MOVEMENT_LABELS[type] ?? type}</ToneBadge>;
}

// FEFO compliance of a dispatch: true, false (override) or null (not a dispatch).
export function FefoBadge({ compliant, reason }) {
  if (compliant === true) return <ToneBadge tone="green">FEFO</ToneBadge>;
  if (compliant === false) {
    return (
      <ToneBadge tone="orange" title={reason ?? undefined}>
        FEFO override
      </ToneBadge>
    );
  }
  return null;
}

const STORAGE_TONES = { ambient: "neutral", cool: "sky", refrigerated: "sky", frozen: "violet" };

export function StorageBadge({ condition, isControlled = false, isSecure = false }) {
  return (
    <span className={styles.badgeRow}>
      <ToneBadge tone={STORAGE_TONES[condition] ?? "neutral"}>{STORAGE_LABELS[condition] ?? condition}</ToneBadge>
      {isControlled && <ToneBadge tone="red">Controlled</ToneBadge>}
      {isSecure && <ToneBadge tone="violet">Secure</ToneBadge>}
    </span>
  );
}

export function ZoneTypeBadge({ zoneType }) {
  return zoneType === "quarantine" ? <ToneBadge tone="amber">Quarantine</ToneBadge> : null;
}

const STAGE_TONES = { pending: "amber", processing: "sky", ready: "violet", in_transit: "sky", received: "green", cancelled: "neutral" };

export function OrderStageBadge({ stage }) {
  return <ToneBadge tone={STAGE_TONES[stage] ?? "neutral"}>{ORDER_STAGE_LABELS[stage] ?? stage}</ToneBadge>;
}

const PICK_TONES = { reserved: "amber", picked: "green", dispatched: "violet", released: "neutral" };

export function PickStatusBadge({ status }) {
  return <ToneBadge tone={PICK_TONES[status] ?? "neutral"}>{PICK_STATUS_LABELS[status] ?? status}</ToneBadge>;
}

// Discrepancy reports, returns, shipments and integration handoffs.
const STATUS_TONES = {
  open: "red",
  acknowledged: "amber",
  resolved: "green",
  pending: "amber",
  approved: "sky",
  rejected: "neutral",
  received: "green",
  in_transit: "sky",
  received_with_discrepancies: "orange",
  sent: "green",
  failed: "red",
  skipped: "neutral",
};

export function StatusBadge({ status, label }) {
  return (
    <ToneBadge tone={STATUS_TONES[status] ?? "neutral"}>
      <span className={styles.capitalize}>{label ?? status.replaceAll("_", " ")}</span>
    </ToneBadge>
  );
}

export function ScanResultBadge({ result }) {
  return <ToneBadge tone={result === "ok" ? "green" : "red"}>{SCAN_RESULT_LABELS[result] ?? result}</ToneBadge>;
}
