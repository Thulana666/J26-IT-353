import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { ALERT_TYPES, SEVERITY, formatDateTime } from "@/lib/pharmacy/format";
import { alertAction, refreshAlertsAction } from "@/app/dashboard/pharmacy/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { ActionForm, InlineAction } from "@/components/pharmacy/forms";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Alerts | Pharmacy | PharmaTwin" };

export default async function AlertsPage({ searchParams }) {
  const { status = "active", type } = await searchParams;
  const [data, error] = await safe(pharmacyApi("/pharmacy/alerts", { query: { status, type } }));
  const link = (changes) => `?${new URLSearchParams({ status, ...(type && { type }), ...changes })}`;

  return (
    <>
      <PharmacyRealtime tables={["pharmacy_alerts"]} />
      <PageHeader
        title="Alerts"
        description="Raised automatically from stock, expiry dates, forecasts and consumption. They clear themselves when the condition is gone."
        mock={false}
      >
        <ActionForm action={refreshAlertsAction} submitLabel="Re-check now" pendingLabel="Checking…" variant="outline" resetOnSuccess={false} className="items-end gap-1" />
      </PageHeader>
      <div className="flex flex-wrap gap-1">
        {["active", "resolved", "all"].map((s) => (
          <Button key={s} size="xs" variant={status === s ? "default" : "outline"} nativeButton={false} render={<Link href={link({ status: s })} />}>
            {s[0].toUpperCase() + s.slice(1)}
          </Button>
        ))}
        <span className="mx-2 border-l" />
        <Button size="xs" variant={!type ? "default" : "outline"} nativeButton={false} render={<Link href={`?status=${status}`} />}>
          All types
        </Button>
        {Object.entries(ALERT_TYPES).map(([key, label]) => (
          <Button key={key} size="xs" variant={type === key ? "default" : "outline"} nativeButton={false} render={<Link href={link({ type: key })} />}>
            {label}
          </Button>
        ))}
      </div>
      {error ? (
        <LoadError message={error} />
      ) : data.alerts.length === 0 ? (
        <EmptyState title="No alerts" />
      ) : (
        <div className="flex flex-col gap-2">
          {data.alerts.map((a) => (
            <Card key={a.id} className={a.status === "resolved" ? "opacity-70" : undefined}>
              <CardContent className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge map={SEVERITY} value={a.severity} />
                    <ToneBadge tone="gray">{ALERT_TYPES[a.type]}</ToneBadge>
                    {a.status === "acknowledged" && <ToneBadge tone="blue">Acknowledged</ToneBadge>}
                    {a.status === "resolved" && <ToneBadge tone="green">Resolved {formatDateTime(a.resolvedAt)}</ToneBadge>}
                    <span className="font-medium">{a.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{a.message}</p>
                  <p className="text-xs text-muted-foreground">
                    Raised {formatDateTime(a.createdAt)} · updated {formatDateTime(a.updatedAt)}
                    {a.medicineId && (
                      <>
                        {" · "}
                        <Link href={`/dashboard/pharmacy/inventory/${a.medicineId}`} className="underline-offset-4 hover:underline">
                          Product
                        </Link>
                        {" · "}
                        <Link href={`/dashboard/pharmacy/analytics?product=${a.medicineId}`} className="underline-offset-4 hover:underline">
                          Forecast
                        </Link>
                      </>
                    )}
                    {a.type === "expired" || a.type === "near_expiry" ? (
                      <>
                        {" · "}
                        <Link href="/dashboard/pharmacy/returns" className="underline-offset-4 hover:underline">
                          Return
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                {a.status !== "resolved" && (
                  <div className="flex shrink-0 gap-2">
                    {a.status === "open" && <InlineAction action={alertAction} fields={{ alertId: a.id, action: "acknowledge" }} label="Acknowledge" />}
                    <InlineAction action={alertAction} fields={{ alertId: a.id, action: "resolve" }} label="Close" variant="ghost" />
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
