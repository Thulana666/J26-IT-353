import { acknowledgeAlertAction } from "@/app/dashboard/cold-chain/actions";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { MapBadge, ToneBadge } from "@/components/cold-chain/badges";
import { EmptyState } from "@/components/pharmacy/ui";
import { ActionForm } from "@/components/warehouse/action-form";
import { ALERT_STATUS, RISK_TYPES, formatDateTime, formatDuration, formatPercent, formatTime } from "@/lib/cold-chain/format";

// Alerts of one shipment, most recent first. Observed alerts are measured
// limit crossings; predicted ones carry the model's probability.
export function AlertsList({ alerts, shipmentId }) {
  if (alerts.length === 0) {
    return <EmptyState title="No alerts">Readings have stayed within the configured limits.</EmptyState>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {alerts.map((alert) => {
        const minutes = (Date.parse(alert.lastDetectedAt) - Date.parse(alert.firstDetectedAt)) / 60_000;
        return (
          <li key={alert.id} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">{alert.title}</p>
                <p className="text-xs text-muted-foreground">
                  {RISK_TYPES[alert.riskType] ?? alert.riskType} · {alert.basis === "observed" ? "measured" : `predicted ${formatPercent(alert.riskProbability)}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1">
                <LevelBadge level={alert.riskLevel} />
                <MapBadge map={ALERT_STATUS} value={alert.status} />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{alert.message}</p>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(alert.firstDetectedAt)}
              {minutes > 0 && ` – ${formatTime(alert.lastDetectedAt)} (${formatDuration(minutes)})`} · {alert.occurrences} reading(s)
              {alert.acknowledgedAt && ` · acknowledged ${formatDateTime(alert.acknowledgedAt)}${alert.acknowledgedBy ? ` by ${alert.acknowledgedBy}` : ""}`}
            </p>
            {alert.status === "open" && (
              <ActionForm action={acknowledgeAlertAction} submitLabel="Acknowledge" pendingLabel="Saving…" variant="outline" className="flex flex-col gap-2">
                <input type="hidden" name="alertId" value={alert.id} />
                <input type="hidden" name="shipmentId" value={shipmentId} />
              </ActionForm>
            )}
            {alert.status === "acknowledged" && (
              <ToneBadge tone="gray" className="self-start">
                Stays active until readings are back within limits
              </ToneBadge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
