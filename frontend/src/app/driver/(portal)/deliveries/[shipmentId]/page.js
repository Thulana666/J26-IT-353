import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { UUID_RE, coldChainApi } from "@/lib/cold-chain/api";
import {
  CONNECTION,
  ISSUE_STATUS,
  ISSUE_TYPES,
  TRIP_STATUS,
  TRUCK_TYPES,
  formatAge,
  formatCoordinate,
  formatDateTime,
  formatHumidity,
  formatTemp,
  formatTime,
  rangeLabel,
} from "@/lib/cold-chain/format";
import { WarehouseApiError } from "@/lib/warehouse/api";
import { AutoRefresh } from "@/components/cold-chain/auto-refresh";
import { MapBadge } from "@/components/cold-chain/badges";
import { ConfirmDelivery } from "@/components/driver/confirm-delivery";
import { ReportIssue } from "@/components/driver/report-issue";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Delivery | PharmaTwin" };

// Another driver's delivery is answered 404 by the backend: show the 404 page.
async function loadDelivery(id) {
  if (!UUID_RE.test(id)) notFound();
  try {
    return [await coldChainApi(`/driver/deliveries/${id}`), null];
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof WarehouseApiError && (error.status === 404 || error.status === 400)) notFound();
    return [null, error.message];
  }
}

function Row({ label, children }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

export default async function DriverDeliveryPage({ params }) {
  const { shipmentId } = await params;
  const [data, error] = await loadDelivery(shipmentId);
  if (error) return <LoadError title="This delivery could not be loaded" message={error} />;

  const { delivery: d, alerts, issues } = data;
  const reading = d.latestReading;
  const position = reading?.latitude !== null && reading?.latitude !== undefined ? reading : null;
  const inTransit = d.status === "in_transit";

  return (
    <>
      {inTransit && <AutoRefresh seconds={30} />}
      <Link href="/driver/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
        ← My deliveries
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{d.shipmentNumber}</h1>
          <p className="text-muted-foreground">to {d.pharmacy?.name ?? "the pharmacy"}</p>
        </div>
        <MapBadge map={TRIP_STATUS} value={d.status} className="mt-1.5" />
      </div>

      {d.status === "delivered" && (
        <div role="status" className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
          <p className="font-semibold text-emerald-400">Delivery completed successfully.</p>
          <p className="text-sm text-muted-foreground">Delivered {formatDateTime(d.deliveredAt)}</p>
        </div>
      )}

      {inTransit && <ConfirmDelivery shipmentId={d.shipmentId} pharmacyName={d.pharmacy?.name} />}
      {d.status === "allocated" && (
        <p className="rounded-xl border p-4 text-sm text-muted-foreground">
          Allocated to you. The warehouse starts the trip when you leave; you can confirm delivery once it is in transit.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Destination</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-base">
            <Row label="Pharmacy">{d.pharmacy?.name ?? "—"}</Row>
            <Row label="Address">{d.pharmacy?.address ?? "—"}</Row>
            {d.pharmacy?.phone && (
              <Row label="Phone">
                <a href={`tel:${d.pharmacy.phone}`} className="font-medium underline-offset-4 hover:underline">
                  {d.pharmacy.phone}
                </a>
              </Row>
            )}
            <Row label="Expected">{d.expectedDeliveryAt ? formatTime(d.expectedDeliveryAt) : "Not set"}</Row>
            {d.predictedArrival && inTransit && <Row label="Predicted">{formatTime(d.predictedArrival)}</Row>}
          </dl>
        </CardContent>
      </Card>

      {d.status !== "allocated" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              {inTransit ? "Live conditions" : "Final conditions"}
              {inTransit && <MapBadge map={CONNECTION} value={d.connection.status} />}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Temperature</p>
                <p className="text-2xl font-semibold">{formatTemp(d.final?.temperatureC ?? reading?.temperatureC)}</p>
                <p className="text-xs text-muted-foreground">safe {rangeLabel(d.limits.tempMinC, d.limits.tempMaxC, "°C")}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Humidity</p>
                <p className="text-2xl font-semibold">{formatHumidity(d.final?.humidityPct ?? reading?.humidityPct)}</p>
                <p className="text-xs text-muted-foreground">{rangeLabel(d.limits.humidityMinPct, d.limits.humidityMaxPct, "%RH")}</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {reading ? `Last sensor update ${formatAge(d.connection.secondsSinceLastReading)} (${formatTime(reading.recordedAt)})` : "No sensor readings yet."}
            </p>
            {position && (
              <p className="text-sm">
                Latest received position {formatCoordinate(position.latitude)}, {formatCoordinate(position.longitude)} ·{" "}
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${position.latitude},${position.longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline-offset-4 hover:underline"
                >
                  Open map ↗
                </a>
              </p>
            )}
            {d.risk && inTransit && (
              <div className="flex items-start gap-2 rounded-lg border p-3">
                <LevelBadge level={d.risk.riskLevel} />
                <p className="text-sm text-muted-foreground">{d.risk.explanation}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {alerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Important alerts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <div key={alert.id} className="flex items-start gap-2 rounded-lg border p-3">
                <LevelBadge level={alert.riskLevel} />
                <div className="min-w-0">
                  <p className="font-medium">{alert.title}</p>
                  <p className="text-sm text-muted-foreground">{alert.message}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {d.status !== "delivered" && <ReportIssue shipmentId={d.shipmentId} />}

      {issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Reported issues</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {issues.map((issue) => (
              <div key={issue.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium">{ISSUE_TYPES[issue.issueType] ?? issue.issueType}</p>
                  <MapBadge map={ISSUE_STATUS} value={issue.status} />
                </div>
                <p className="text-sm text-muted-foreground">{issue.description}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(issue.reportedAt)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Shipment</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-base">
            <Row label="Order">{d.orderNumber ?? "—"}</Row>
            <Row label="From">{d.warehouse?.name ?? "—"}</Row>
            <Row label="Truck">
              {d.truck ? `${d.truck.registrationNumber} · ${TRUCK_TYPES[d.truck.truckType] ?? d.truck.truckType}` : "—"}
            </Row>
            <Row label="Items">
              {d.items.length ? (
                <ul className="flex flex-col gap-0.5">
                  {d.items.map((item, index) => (
                    <li key={index}>
                      {[item.medicineName, item.strength].filter(Boolean).join(" ")} · {item.quantityShipped} pack(s)
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              )}
            </Row>
          </dl>
        </CardContent>
      </Card>
    </>
  );
}
