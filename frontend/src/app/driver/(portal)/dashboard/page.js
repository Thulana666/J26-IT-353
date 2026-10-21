import Link from "next/link";
import { coldChainApi } from "@/lib/cold-chain/api";
import { TRIP_STATUS, formatDateTime, formatHumidity, formatTemp, formatTime } from "@/lib/cold-chain/format";
import { safe } from "@/lib/warehouse/page-data";
import { AutoRefresh } from "@/components/cold-chain/auto-refresh";
import { MapBadge } from "@/components/cold-chain/badges";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "My deliveries | PharmaTwin" };

function DeliveryRow({ delivery }) {
  return (
    <Link
      href={`/driver/deliveries/${delivery.shipmentId}`}
      className="flex items-center justify-between gap-3 rounded-xl border p-4 transition-colors hover:bg-muted/50 active:bg-muted"
    >
      <span className="min-w-0">
        <span className="block font-medium">{delivery.pharmacy?.name ?? "Pharmacy"}</span>
        <span className="block text-sm text-muted-foreground">
          {delivery.shipmentNumber}
          {delivery.status === "delivered"
            ? ` · delivered ${formatDateTime(delivery.deliveredAt)}`
            : delivery.expectedDeliveryAt
              ? ` · ETA ${formatTime(delivery.expectedDeliveryAt)}`
              : ""}
        </span>
      </span>
      <MapBadge map={TRIP_STATUS} value={delivery.status} />
    </Link>
  );
}

export default async function DriverDashboardPage() {
  const [data, error] = await safe(coldChainApi("/driver/deliveries"));
  if (error) return <LoadError title="Your deliveries could not be loaded" message={error} />;

  const active = data.active[0] ?? null;
  const firstName = data.driver.fullName.split(" ")[0];
  const allocated = data.active.length + data.upcoming.length;

  return (
    <>
      {data.active.length > 0 && <AutoRefresh seconds={30} />}
      <div>
        <h1 className="text-2xl font-semibold">Hello, {firstName}</h1>
        <p className="text-muted-foreground">
          {allocated === 0 ? "No deliveries allocated to you right now." : `${allocated} allocated deliver${allocated === 1 ? "y" : "ies"}.`}
        </p>
      </div>

      {active ? (
        <Card className="border-foreground/30">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-lg">
              Active delivery <MapBadge map={TRIP_STATUS} value={active.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-base">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">Shipment</dt>
              <dd className="font-medium">{active.shipmentNumber}</dd>
              <dt className="text-muted-foreground">Destination</dt>
              <dd>{active.pharmacy?.name ?? "—"}</dd>
              <dt className="text-muted-foreground">ETA</dt>
              <dd>{active.expectedDeliveryAt ? formatTime(active.expectedDeliveryAt) : "Not set"}</dd>
              <dt className="text-muted-foreground">Conditions</dt>
              <dd>
                {formatTemp(active.latestReading?.temperatureC)} · {formatHumidity(active.latestReading?.humidityPct)}
              </dd>
              {active.risk && (
                <>
                  <dt className="text-muted-foreground">Risk</dt>
                  <dd>
                    <LevelBadge level={active.risk.riskLevel} />
                  </dd>
                </>
              )}
            </dl>
            <Button nativeButton={false} render={<Link href={`/driver/deliveries/${active.shipmentId}`} />} size="lg" className="h-12 w-full text-base font-semibold">
              View delivery
            </Button>
          </CardContent>
        </Card>
      ) : (
        <EmptyState title="No active delivery">When the warehouse starts one of your deliveries it appears here.</EmptyState>
      )}

      {(data.active.length > 1 || data.upcoming.length > 0) && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Allocated to you</h2>
          {[...data.active.slice(1), ...data.upcoming].map((delivery) => (
            <DeliveryRow key={delivery.shipmentId} delivery={delivery} />
          ))}
        </section>
      )}

      {data.recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Recently delivered</h2>
          {data.recent.map((delivery) => (
            <DeliveryRow key={delivery.shipmentId} delivery={delivery} />
          ))}
        </section>
      )}
    </>
  );
}
