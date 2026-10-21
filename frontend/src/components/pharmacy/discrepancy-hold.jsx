"use client";

import { settleDiscrepancyHoldAction } from "@/app/dashboard/pharmacy/actions";
import { ToneBadge } from "@/components/pharmacy/badges";
import { InlineAction } from "@/components/pharmacy/forms";

// Stock held by one discrepancy report (a problem found after the item was
// already in stock). Once the warehouse has resolved the report, staff release
// the units to available stock or write them off; both happen once only.
export function DiscrepancyHold({ report }) {
  if (!report.heldUnits) return null;
  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      <ToneBadge tone="amber">{report.heldUnits} unit(s) held</ToneBadge>
      {report.status === "resolved" ? (
        <div className="flex flex-wrap gap-1">
          <InlineAction
            action={settleDiscrepancyHoldAction}
            fields={{ discrepancyId: report.id, outcome: "release" }}
            label="Release to stock"
            size="xs"
            confirm={`Release ${report.heldUnits} unit(s) back to available stock?`}
          />
          <InlineAction
            action={settleDiscrepancyHoldAction}
            fields={{ discrepancyId: report.id, outcome: "write_off" }}
            label="Write off"
            size="xs"
            variant="ghost"
            confirm={`Remove ${report.heldUnits} unit(s) from stock permanently?`}
          />
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Not sellable until the warehouse resolves the report</span>
      )}
    </div>
  );
}
