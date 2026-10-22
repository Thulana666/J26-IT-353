import Link from "next/link";
import { coldChainApi } from "@/lib/cold-chain/api";
import {
  CONNECTION,
  LIMIT_STATE,
  SHIPMENT_STATUS,
  TRIP_STATUS,
  formatAge,
  formatDuration,
  formatHumidity,
  formatPercent,
  formatTemp,
  formatTime,
  limitState,
  rangeLabel,
} from "@/lib/cold-chain/format";
import { getNavItem } from "@/lib/navigation";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { ActivityIcon } from "@/components/icons/activity";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { MapPinIcon } from "@/components/icons/map-pin";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { MapBadge, TestDataBadge } from "@/components/cold-chain/badges";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { RealtimeRefresh } from "@/components/pharmacy/realtime-refresh";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const page = getNavItem("/dashboard/cold-chain");

export const metadata = { title: "Cold Chain | PharmaTwin" };

const outsideLimits = (s) =>
  [
    limitState(s.latestReading?.temperatureC, s.limits.tempMinC, s.limits.tempMaxC),
    limitState(s.latestReading?.humidityPct, s.limits.humidityMinPct, s.limits.humidityMaxPct),
  ].some((state) => state === "above" || state === "below");

export default async function ColdChainPage() {
  const [{ profile }, [data, error]] = await Promise.all([getViewer(), safe(coldChainApi("/shipments", { query: { tripStatus: "ready_for_dispatch,allocated,in_transit", limit: 100 } }))]);
  // Admins and warehouse staff start monitoring and manage devices (the backend enforces it too).
  const canManage = profile?.status === "active" && ["admin", "warehouse_staff"].includes(profile.role);
  if (error) {
    return (
      <>
        <PageHeader title="Cold Chain" description={page.description} mock={false} />
        <LoadError title="Cold-chain data could not be loaded" message={error} />
      </>
    );
  }

  const shipments = data.shipments;
  const active = shipments.filter((s) => s.monitoringStatus === "active");
  const openAlerts = shipments.reduce((sum, s) => sum + s.openAlerts.count, 0);
  const highAlertShipments = shipments.filter((s) => s.openAlerts.highestLevel === "high").length;
  const connectionIssues = active.filter((s) => ["delayed", "offline"].includes(s.connection.status)).length;
  const hasTestData = shipments.some((s) => s.isTest);

  return (
    <>
      <RealtimeRefresh tables={["cold_chain_shipments", "cold_chain_readings", "cold_chain_alerts", "cold_chain_risk_predictions"]} />
      <PageHeader title="Cold Chain" description={page.description} mock={false}>
        {hasTestData && <TestDataBadge />}
        {canManage && (
          <>
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/cold-chain/drivers" />}>
              Drivers
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/cold-chain/trucks" />}>
              Trucks
            </Button>
            <Button nativeButton={false} render={<Link href="/dashboard/cold-chain/start" />}>
              Create shipment
            </Button>
          </>
        )}
      </PageHeader>

      {hasTestData && (
        <Alert>
          <AlertTitle>Includes test data</AlertTitle>
          <AlertDescription>
            Shipments marked Test data hold simulated readings from the development simulator, not real sensor data. They are
            kept apart from real readings and must not be used as research results.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Live trips"
          value={shipments.length}
          hint={`${shipments.filter((s) => s.trip.status === "in_transit").length} in transit · ${shipments.filter((s) => s.trip.status !== "in_transit").length} awaiting start`}
          icon={MapPinIcon}
        />
        <StatCard label="Outside limits now" value={active.filter(outsideLimits).length} hint="newest temperature or humidity reading" icon={ActivityIcon} />
        <StatCard label="Open alerts" value={openAlerts} hint={`${highAlertShipments} shipment(s) with a high alert`} icon={BadgeAlertIcon} />
        <StatCard label="Connection issues" value={connectionIssues} hint="sensors delayed or offline" icon={RefreshCWIcon} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live shipments</CardTitle>
          <CardDescription>
            Ready for dispatch, allocated and in transit. Open a shipment to allocate, start, track or deliver it;{" "}
            <Link href="/dashboard/cold-chain/history" className="font-medium underline-offset-4 hover:underline">
              delivered ones are in History →
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {shipments.length === 0 ? (
            <EmptyState title="No monitored shipments">
              {canManage ? (
                <Link href="/dashboard/cold-chain/start" className="font-medium underline-offset-4 hover:underline">
                  Create a shipment from a dispatched order →
                </Link>
              ) : (
                "An admin or warehouse staff member starts monitoring when a shipment is dispatched."
              )}
            </EmptyState>
          ) : (
            <ShipmentsTable shipments={shipments} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ShipmentsTable({ shipments }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Shipment</TableHead>
          <TableHead>Route</TableHead>
          <TableHead>Trip</TableHead>
          <TableHead className="text-right">Temperature</TableHead>
          <TableHead className="text-right">Humidity</TableHead>
          <TableHead>Sensor</TableHead>
          <TableHead>Delivery</TableHead>
          <TableHead>Alerts</TableHead>
          <TableHead>Predicted risk</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {shipments.map((s) => {
          const reading = s.latestReading;
          const temperature = limitState(reading?.temperatureC, s.limits.tempMinC, s.limits.tempMaxC);
          const humidity = limitState(reading?.humidityPct, s.limits.humidityMinPct, s.limits.humidityMaxPct);
          return (
            <TableRow key={s.shipmentId}>
              <TableCell>
                <Link href={`/dashboard/cold-chain/${s.shipmentId}`} className="font-medium underline-offset-4 hover:underline">
                  {s.shipmentNumber}
                </Link>
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.isTest && <TestDataBadge />}
                  {s.monitoringStatus === "ended" && <MapBadge map={CONNECTION} value="ended" />}
                </div>
              </TableCell>
              <TableCell className="max-w-56 whitespace-normal">
                <div className="text-sm">
                  {s.origin?.name ?? "—"} → {s.destination?.name ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">{s.items.map((item) => item.medicineName).filter(Boolean).join(", ") || "No items"}</div>
              </TableCell>
              <TableCell>
                <MapBadge map={TRIP_STATUS} value={s.trip.status} />
                <div className="text-xs text-muted-foreground">{s.driver?.fullName ?? "No driver"}</div>
                <div className="font-mono text-xs text-muted-foreground">{s.truck?.registrationNumber ?? "No truck"}</div>
              </TableCell>
              <TableCell className="text-right">
                <div className="tabular-nums">{formatTemp(reading?.temperatureC)}</div>
                <div className="text-xs text-muted-foreground">{rangeLabel(s.limits.tempMinC, s.limits.tempMaxC, "°C")}</div>
                {temperature && temperature !== "ok" && <MapBadge map={LIMIT_STATE} value={temperature} />}
              </TableCell>
              <TableCell className="text-right">
                <div className="tabular-nums">{formatHumidity(reading?.humidityPct)}</div>
                <div className="text-xs text-muted-foreground">{rangeLabel(s.limits.humidityMinPct, s.limits.humidityMaxPct, "%RH")}</div>
                {humidity && humidity !== "ok" && <MapBadge map={LIMIT_STATE} value={humidity} />}
              </TableCell>
              <TableCell>
                <MapBadge map={CONNECTION} value={s.connection.status} />
                <div className="text-xs text-muted-foreground">{formatAge(s.connection.secondsSinceLastReading)}</div>
              </TableCell>
              <TableCell>
                <MapBadge map={SHIPMENT_STATUS} value={s.delivery.status} />
                <div className="text-xs text-muted-foreground">
                  {s.delivery.isOverdue
                    ? `Overdue by ${formatDuration(s.delivery.delayMinutes)}`
                    : s.delivery.isDelivered
                      ? `Delivered ${formatTime(s.delivery.actualDeliveryAt)}`
                      : s.delivery.expectedDeliveryAt
                        ? `ETA ${formatTime(s.delivery.expectedDeliveryAt)}`
                        : "No ETA set"}
                </div>
              </TableCell>
              <TableCell>
                {s.openAlerts.count === 0 ? (
                  <span className="text-xs text-muted-foreground">None open</span>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <LevelBadge level={s.openAlerts.highestLevel} />
                    <span className="text-xs text-muted-foreground">{s.openAlerts.count} open</span>
                  </div>
                )}
              </TableCell>
              <TableCell>
                {s.latestPrediction ? (
                  <div className="flex items-center gap-1.5">
                    <LevelBadge level={s.latestPrediction.riskLevel} />
                    <span className="text-xs tabular-nums text-muted-foreground">{formatPercent(s.latestPrediction.riskProbability)}</span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">No prediction yet</span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
