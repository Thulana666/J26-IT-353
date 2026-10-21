import Link from "next/link";
import { coldChainApi } from "@/lib/cold-chain/api";
import { SHIPMENT_STATUS, formatDateTime, formatDuration, formatPercent, rangeLabel } from "@/lib/cold-chain/format";
import { safe } from "@/lib/warehouse/page-data";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { MapBadge, TestDataBadge, ToneBadge } from "@/components/cold-chain/badges";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Shipment history | PharmaTwin" };

const one = (value) => (value === null || value === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value));

function riskLevelOf(probability) {
  if (probability === null || probability === undefined) return null;
  return probability >= 0.7 ? "high" : probability >= 0.3 ? "medium" : "low";
}

export default async function ShipmentHistoryPage() {
  const [data, error] = await safe(coldChainApi("/shipments", { query: { tripStatus: "delivered", limit: 200 } }));
  return (
    <>
      <PageHeader title="Shipment history" description="Delivered trips with their conditions, alerts and highest predicted risk." mock={false} />
      <Card>
        <CardHeader>
          <CardTitle>Delivered shipments</CardTitle>
          <CardDescription>
            Readings, alerts and predictions are kept after delivery; open a shipment to see its full history. Readings outside
            the limits are counted against each shipment&apos;s own limits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <LoadError title="History could not be loaded" message={error} />
          ) : data.shipments.length === 0 ? (
            <EmptyState title="No delivered shipments yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Pharmacy</TableHead>
                  <TableHead>Driver · truck</TableHead>
                  <TableHead>Trip</TableHead>
                  <TableHead>Temperature</TableHead>
                  <TableHead>Humidity</TableHead>
                  <TableHead>Risk · alerts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.shipments.map((s) => {
                  const summary = s.summary;
                  const level = riskLevelOf(summary?.maxRiskProbability);
                  return (
                    <TableRow key={s.shipmentId}>
                      <TableCell className="align-top">
                        <Link href={`/dashboard/cold-chain/${s.shipmentId}`} className="font-medium underline-offset-4 hover:underline">
                          {s.shipmentNumber}
                        </Link>
                        <div className="text-xs text-muted-foreground">{s.orderNumber ?? ""}</div>
                        {s.isTest && <TestDataBadge />}
                      </TableCell>
                      <TableCell className="max-w-48 align-top whitespace-normal">
                        <div className="text-sm">{s.destination?.name ?? "—"}</div>
                        <MapBadge map={SHIPMENT_STATUS} value={s.delivery.status} />
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="text-sm">{s.driver?.fullName ?? "—"}</div>
                        <div className="font-mono text-xs text-muted-foreground">{s.truck?.registrationNumber ?? "—"}</div>
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        <div>Start {s.trip.startedAt ? formatDateTime(s.trip.startedAt) : "—"}</div>
                        <div>Delivered {formatDateTime(s.trip.deliveredAt)}</div>
                        <div className="text-muted-foreground">{s.trip.durationMinutes !== null ? formatDuration(s.trip.durationMinutes) : "—"}</div>
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {summary?.readings ? (
                          <>
                            <div className="tabular-nums">
                              {one(summary.temperature.min)}–{one(summary.temperature.max)} °C (avg {one(summary.temperature.avg)})
                            </div>
                            <div className="text-muted-foreground">limits {rangeLabel(s.limits.tempMinC, s.limits.tempMaxC, "°C")}</div>
                            {summary.temperature.outside > 0 && <ToneBadge tone="red">{summary.temperature.outside} outside</ToneBadge>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">No readings</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {summary?.readings ? (
                          <>
                            <div className="tabular-nums">
                              {one(summary.humidity.min)}–{one(summary.humidity.max)} %RH
                            </div>
                            {summary.humidity.outside > 0 && <ToneBadge tone="amber">{summary.humidity.outside} outside</ToneBadge>}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {level ? (
                          <div className="flex items-center gap-1.5">
                            <LevelBadge level={level} />
                            <span className="tabular-nums text-muted-foreground">max {formatPercent(summary.maxRiskProbability)}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">No prediction</span>
                        )}
                        <div className="mt-1 text-muted-foreground">
                          {summary?.alerts ?? 0} alert(s){summary?.highAlerts ? `, ${summary.highAlerts} high` : ""}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
