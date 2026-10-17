import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { UUID_RE, coldChainApi } from "@/lib/cold-chain/api";
import {
  CONNECTION,
  LIMIT_STATE,
  SHIPMENT_STATUS,
  STORAGE_LABELS,
  formatAge,
  formatCoordinate,
  formatDateTime,
  formatDuration,
  formatHumidity,
  formatSpeed,
  formatTemp,
  formatTime,
  limitState,
  rangeLabel,
} from "@/lib/cold-chain/format";
import { safe } from "@/lib/warehouse/page-data";
import { WarehouseApiError } from "@/lib/warehouse/api";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { MapPinIcon } from "@/components/icons/map-pin";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { AlertsList } from "@/components/cold-chain/alerts-list";
import { MapBadge, TestDataBadge, ToneBadge } from "@/components/cold-chain/badges";
import { ConditionChart, RouteChart } from "@/components/cold-chain/charts";
import { MapPreview, mapLinks } from "@/components/cold-chain/map-preview";
import { ReadingsTable } from "@/components/cold-chain/readings-table";
import { RiskCard } from "@/components/cold-chain/risk-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { RealtimeRefresh } from "@/components/pharmacy/realtime-refresh";
import { DefinitionList, EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Cold-chain shipment | PharmaTwin" };

// Readings drawn in the charts: 12 hours at one reading a minute.
const CHART_READINGS = 720;
const TABLE_READINGS = 15;
// GPS fixes the map preview is framed on (the last hour at one reading a minute).
const MAP_TRACK_FIXES = 60;

// Loads a monitored shipment; unknown or malformed ids show the Next.js 404 page.
async function loadShipment(id) {
  if (!UUID_RE.test(id)) notFound();
  try {
    return [(await coldChainApi(`/shipments/${id}`)).shipment, null];
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof WarehouseApiError && (error.status === 404 || error.status === 400)) notFound();
    return [null, error.message];
  }
}

// Data-quality figures for the readings in view: flags, missing values and
// communication gaps (no reading for more than 3 reading intervals).
function qualitySummary(readings, intervalSeconds) {
  const flags = {};
  let gaps = 0;
  let longestGapMinutes = 0;
  let missingTemperature = 0;
  readings.forEach((reading, i) => {
    for (const flag of reading.qualityFlags) flags[flag] = (flags[flag] ?? 0) + 1;
    if (reading.temperatureC === null) missingTemperature += 1;
    if (i > 0) {
      const seconds = (Date.parse(reading.recordedAt) - Date.parse(readings[i - 1].recordedAt)) / 1000;
      if (seconds > 3 * intervalSeconds) {
        gaps += 1;
        longestGapMinutes = Math.max(longestGapMinutes, seconds / 60);
      }
    }
  });
  return { flags, gaps, longestGapMinutes, missingTemperature };
}

function deliveryNote(delivery) {
  if (delivery.isDelivered) {
    return delivery.delayMinutes ? `Delivered ${formatDuration(delivery.delayMinutes)} late` : "Delivered on time";
  }
  if (delivery.isOverdue) return `Overdue by ${formatDuration(delivery.delayMinutes)}`;
  return delivery.expectedDeliveryAt ? "On schedule" : "No expected delivery time set";
}

export default async function ColdChainShipmentPage({ params }) {
  const { shipmentId } = await params;
  const [shipment, error] = await loadShipment(shipmentId);
  if (error) {
    return (
      <>
        <PageHeader title="Cold-chain shipment" mock={false} />
        <LoadError title="Shipment data could not be loaded" message={error} />
      </>
    );
  }

  const [[readingsData, readingsError], [alertsData, alertsError], [riskData, riskError]] = await Promise.all([
    safe(coldChainApi(`/shipments/${shipmentId}/readings`, { query: { limit: CHART_READINGS } })),
    safe(coldChainApi(`/shipments/${shipmentId}/alerts`, { query: { limit: 50 } })),
    safe(coldChainApi(`/shipments/${shipmentId}/risk`)),
  ]);

  const s = shipment;
  const readings = readingsData?.readings ?? [];
  const latest = s.latestReading;
  const points = readings.map((r) => ({
    t: Date.parse(r.recordedAt),
    temperatureC: r.temperatureC,
    humidityPct: r.humidityPct,
    latitude: r.latitude,
    longitude: r.longitude,
    speedKmh: r.speedKmh,
    flags: r.qualityFlags,
  }));
  const quality = qualitySummary(readings, s.readingIntervalSeconds);
  const temperatureState = limitState(latest?.temperatureC, s.limits.tempMinC, s.limits.tempMaxC);
  const humidityState = limitState(latest?.humidityPct, s.limits.humidityMinPct, s.limits.humidityMaxPct);
  const latestFix = [...readings].reverse().find((r) => r.latitude !== null);
  const links = latestFix ? mapLinks(latestFix) : null;
  // The map preview frames the most recent stretch of the route, without flagged GPS jumps.
  const recentTrack = readings
    .filter((r) => r.latitude !== null && !r.qualityFlags.includes("gps_jump"))
    .slice(-MAP_TRACK_FIXES);
  const span = readings.length ? `${formatTime(readings[0].recordedAt)}–${formatTime(readings.at(-1).recordedAt)}` : null;
  const viewNote = readings.length
    ? `${readings.length} reading(s), ${span}${readingsData.truncated ? " (older readings not shown)" : ""}.`
    : "No readings yet.";

  return (
    <>
      <RealtimeRefresh
        tables={["cold_chain_readings", "cold_chain_alerts", "cold_chain_risk_predictions", "cold_chain_shipments"]}
        filter={`shipment_id=eq.${s.shipmentId}`}
      />
      <PageHeader title={`Shipment ${s.shipmentNumber}`} description={`${s.origin?.name ?? "Unknown origin"} → ${s.destination?.name ?? "Unknown destination"}`} mock={false}>
        {s.isTest && <TestDataBadge />}
        <MapBadge map={CONNECTION} value={s.connection.status} />
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/cold-chain" />}>
          All shipments
        </Button>
      </PageHeader>

      {s.isTest && (
        <Alert>
          <AlertTitle>Test shipment</AlertTitle>
          <AlertDescription>
            These readings come from the simulator device {s.device?.deviceCode ?? ""}, not from real sensors. Do not use them as
            research results.
          </AlertDescription>
        </Alert>
      )}

      {/* Current conditions */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          label="Temperature"
          value={formatTemp(latest?.temperatureC)}
          hint={`Safe ${rangeLabel(s.limits.tempMinC, s.limits.tempMaxC, "°C")}${temperatureState ? ` · ${LIMIT_STATE[temperatureState][0]}` : ""}`}
        />
        <StatCard
          label="Humidity"
          value={formatHumidity(latest?.humidityPct)}
          hint={`Safe ${rangeLabel(s.limits.humidityMinPct, s.limits.humidityMaxPct, "%RH")}${humidityState ? ` · ${LIMIT_STATE[humidityState][0]}` : ""}`}
        />
        <StatCard
          label="Speed"
          value={formatSpeed(latest?.speedKmh)}
          hint={latestFix ? `GPS ${formatCoordinate(latestFix.latitude)}, ${formatCoordinate(latestFix.longitude)}` : "No GPS fix yet"}
          icon={MapPinIcon}
        />
        <StatCard
          label="Last updated"
          value={formatAge(s.connection.secondsSinceLastReading)}
          hint={latest ? `${formatDateTime(latest.recordedAt)} · ${CONNECTION[s.connection.status][0]}` : CONNECTION[s.connection.status][0]}
          icon={RefreshCWIcon}
        />
        <StatCard
          label="Expected delivery"
          value={s.delivery.expectedDeliveryAt ? formatTime(s.delivery.expectedDeliveryAt) : "—"}
          hint={deliveryNote(s.delivery)}
          icon={CalendarDaysIcon}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Shipment</CardTitle>
            <CardDescription>Warehouse → pharmacy delivery (Component 4) under cold-chain monitoring.</CardDescription>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                ["Shipment", s.shipmentNumber],
                [
                  "Medicines",
                  s.items.length ? (
                    <ul className="flex flex-col gap-1">
                      {s.items.map((item) => (
                        <li key={item.id}>
                          {[item.medicineName, item.strength].filter(Boolean).join(" ")}
                          <span className="text-muted-foreground">
                            {" "}
                            · batch {item.batchNumber ?? "—"} · {item.quantityShipped} pack(s)
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "No items"
                  ),
                ],
                ["Origin", s.origin?.name],
                ["Destination", s.destination?.name],
                ["Status", <MapBadge key="status" map={SHIPMENT_STATUS} value={s.delivery.status} />],
                ["Dispatched", formatDateTime(s.delivery.dispatchedAt)],
                ["Expected delivery", s.delivery.expectedDeliveryAt ? `${formatDateTime(s.delivery.expectedDeliveryAt)} · ${deliveryNote(s.delivery)}` : "Not set"],
                ["Actual delivery", s.delivery.actualDeliveryAt ? formatDateTime(s.delivery.actualDeliveryAt) : "Not received yet"],
                ["Storage", STORAGE_LABELS[s.limits.storageCondition] ?? s.limits.storageCondition],
                ["Limits", `${rangeLabel(s.limits.tempMinC, s.limits.tempMaxC, "°C")} · humidity ${rangeLabel(s.limits.humidityMinPct, s.limits.humidityMaxPct, "%RH")}`],
                [
                  "Sensor",
                  s.device ? (
                    <span key="device">
                      {s.device.deviceCode}{" "}
                      <span className="text-muted-foreground">
                        ({s.device.deviceType === "simulator" ? "simulator" : "ESP32"}) · every {s.readingIntervalSeconds} s
                      </span>
                    </span>
                  ) : (
                    "No device assigned"
                  ),
                ],
                ["Monitoring", s.monitoringStatus === "active" ? `Since ${formatDateTime(s.startedAt)}` : `Ended ${formatDateTime(s.endedAt)}`],
              ]}
            />
          </CardContent>
        </Card>

        <RiskCard prediction={riskData?.prediction ?? null} error={riskError} />
      </div>

      {readingsError ? (
        <LoadError title="Readings could not be loaded" message={readingsError} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Temperature</CardTitle>
              <CardDescription>
                {viewNote} Shaded: safe range for this shipment ({rangeLabel(s.limits.tempMinC, s.limits.tempMaxC, "°C")}). Gaps in the line are
                periods without readings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {points.some((p) => p.temperatureC !== null) ? (
                <ConditionChart
                  points={points}
                  field="temperatureC"
                  name="Temperature"
                  unit="°C"
                  min={s.limits.tempMinC}
                  max={s.limits.tempMaxC}
                  intervalSeconds={s.readingIntervalSeconds}
                />
              ) : (
                <EmptyState title="No temperature readings yet" />
              )}
            </CardContent>
          </Card>

          <div className="grid items-start gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Humidity</CardTitle>
                <CardDescription>Shaded: configured range ({rangeLabel(s.limits.humidityMinPct, s.limits.humidityMaxPct, "%RH")}).</CardDescription>
              </CardHeader>
              <CardContent>
                {points.some((p) => p.humidityPct !== null) ? (
                  <ConditionChart
                    points={points}
                    field="humidityPct"
                    name="Humidity"
                    unit="%RH"
                    min={s.limits.humidityMinPct}
                    max={s.limits.humidityMaxPct}
                    intervalSeconds={s.readingIntervalSeconds}
                    height={220}
                  />
                ) : (
                  <EmptyState title="No humidity readings yet" />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Location</CardTitle>
                <CardDescription>
                  {latestFix ? (
                    <>
                      Latest fix {formatCoordinate(latestFix.latitude)}, {formatCoordinate(latestFix.longitude)} at {formatTime(latestFix.recordedAt)} · Open in{" "}
                      <a href={links.google} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                        Google Maps ↗
                      </a>{" "}
                      or{" "}
                      <a href={links.openStreetMap} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                        OpenStreetMap ↗
                      </a>
                    </>
                  ) : (
                    "No GPS fix in the readings shown."
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {latestFix ? (
                  <>
                    <MapPreview latest={latestFix} track={recentTrack} height={200} />
                    <div>
                      <p className="mb-1 text-xs text-muted-foreground">Recorded track (not to scale)</p>
                      <RouteChart points={points} height={180} />
                    </div>
                  </>
                ) : (
                  <EmptyState title="No GPS fix yet" />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
            <CardDescription>Measured limit crossings, most recent first. Predicted risks appear here once a predictor runs.</CardDescription>
          </CardHeader>
          <CardContent>
            {alertsError ? <LoadError title="Alerts could not be loaded" message={alertsError} /> : <AlertsList alerts={alertsData.alerts} shipmentId={s.shipmentId} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data quality</CardTitle>
            <CardDescription>Readings in view. Values are stored exactly as sent; suspicious ones are flagged, never adjusted.</CardDescription>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                ["Readings", viewNote],
                ["Delayed uploads", `${quality.flags.delayed_upload ?? 0} (buffered and sent later)`],
                ["GPS jumps", `${quality.flags.gps_jump ?? 0}`],
                ["After delivery", `${quality.flags.after_delivery ?? 0}`],
                ["Missing temperature", `${quality.missingTemperature}`],
                [
                  "Communication gaps",
                  quality.gaps ? `${quality.gaps} (longest ${formatDuration(quality.longestGapMinutes)})` : `None longer than ${formatDuration((3 * s.readingIntervalSeconds) / 60)}`,
                ],
              ]}
            />
            {(quality.flags.delayed_upload ?? 0) > 0 && s.isTest && (
              <ToneBadge tone="gray" className="mt-3">
                Simulated history is uploaded at once, so it is flagged as delayed
              </ToneBadge>
            )}
          </CardContent>
        </Card>
      </div>

      {!readingsError && readings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent readings</CardTitle>
            <CardDescription>The {Math.min(TABLE_READINGS, readings.length)} newest readings (table view of the charts).</CardDescription>
          </CardHeader>
          <CardContent>
            <ReadingsTable readings={readings.slice(-TABLE_READINGS).reverse()} limits={s.limits} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
