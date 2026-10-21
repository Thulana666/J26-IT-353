import { setIssueStatusAction } from "@/app/dashboard/cold-chain/actions";
import { MapBadge } from "@/components/cold-chain/badges";
import { InlineAction } from "@/components/pharmacy/forms";
import { EmptyState } from "@/components/pharmacy/ui";
import { ISSUE_STATUS, ISSUE_TYPES, formatCoordinate, formatDateTime, formatHumidity, formatTemp } from "@/lib/cold-chain/format";

// Issues the driver reported for one shipment (newest first). Admins and
// warehouse staff move them to "in review" and "resolved".
export function IssuesList({ issues, canManage }) {
  if (issues.length === 0) return <EmptyState title="No issues reported by the driver" />;
  return (
    <ul className="flex flex-col gap-2">
      {issues.map((issue) => (
        <li key={issue.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{ISSUE_TYPES[issue.issueType] ?? issue.issueType}</p>
              <p className="text-xs text-muted-foreground">
                {issue.driverName ?? "Driver"} · {formatDateTime(issue.reportedAt)}
              </p>
            </div>
            <MapBadge map={ISSUE_STATUS} value={issue.status} />
          </div>
          <p className="text-sm text-muted-foreground">{issue.description}</p>
          {issue.snapshot && (
            <p className="text-xs text-muted-foreground">
              Sensor at the time: {formatTemp(issue.snapshot.temperatureC)} · {formatHumidity(issue.snapshot.humidityPct)}
              {issue.snapshot.latitude !== null && ` · ${formatCoordinate(issue.snapshot.latitude)}, ${formatCoordinate(issue.snapshot.longitude)}`}
            </p>
          )}
          {issue.resolvedAt && (
            <p className="text-xs text-muted-foreground">
              Resolved {formatDateTime(issue.resolvedAt)}
              {issue.resolvedBy ? ` by ${issue.resolvedBy}` : ""}
            </p>
          )}
          {canManage && issue.status !== "resolved" && (
            <div className="flex flex-wrap gap-2">
              {issue.status === "open" && (
                <InlineAction action={setIssueStatusAction} fields={{ issueId: issue.id, status: "in_review" }} label="Mark in review" />
              )}
              <InlineAction action={setIssueStatusAction} fields={{ issueId: issue.id, status: "resolved" }} label="Resolve" />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
