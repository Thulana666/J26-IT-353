import Link from "next/link";
import { setTruckStatusAction } from "@/app/dashboard/cold-chain/actions";
import { coldChainApi } from "@/lib/cold-chain/api";
import { TRIP_STATUS, TRUCK_STATUS, TRUCK_TYPES, rangeLabel } from "@/lib/cold-chain/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { MapBadge, ToneBadge } from "@/components/cold-chain/badges";
import { TruckForm } from "@/components/cold-chain/fleet-forms";
import { PageHeader } from "@/components/dashboard/page-header";
import { InlineAction } from "@/components/pharmacy/forms";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Trucks | PharmaTwin" };

export default async function TrucksPage() {
  const { profile } = await getViewer();
  const canManage = profile?.status === "active" && ["admin", "warehouse_staff"].includes(profile.role);
  const header = (
    <PageHeader title="Trucks" description="Trucks for cold-chain trips: refrigeration range, installed sensor and availability." mock={false} />
  );
  if (!canManage) {
    return (
      <>
        {header}
        <LoadError title="Not available for your role" message="Only admins and warehouse staff manage trucks." />
      </>
    );
  }

  const [[data, error], [devicesData]] = await Promise.all([safe(coldChainApi("/trucks")), safe(coldChainApi("/devices"))]);
  const trucks = data?.trucks ?? [];
  // A sensor can be installed in one truck: offer those not installed elsewhere.
  const installed = new Map(trucks.filter((t) => t.device).map((t) => [t.device.id, t.id]));
  const devicesFor = (truckId) => (devicesData?.devices ?? []).filter((d) => d.isActive && (!installed.has(d.id) || installed.get(d.id) === truckId));

  return (
    <>
      {header}
      <Card>
        <CardHeader>
          <CardTitle>Add truck</CardTitle>
          <CardDescription>
            Temperature-controlled shipments can only be allocated to refrigerated trucks whose range covers their limits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TruckForm devices={devicesFor(null)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trucks</CardTitle>
          <CardDescription>Assigned and in-use statuses follow the trip workflow; deactivate trucks that are out of service.</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <LoadError title="Trucks could not be loaded" message={error} />
          ) : trucks.length === 0 ? (
            <EmptyState title="No trucks yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Truck</TableHead>
                  <TableHead>Refrigeration</TableHead>
                  <TableHead>Sensor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Current trip</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trucks.map((truck) => (
                  <TableRow key={truck.id}>
                    <TableCell className="align-top">
                      <div className="font-mono font-medium">{truck.registrationNumber}</div>
                      <div className="text-xs text-muted-foreground">{TRUCK_TYPES[truck.truckType] ?? truck.truckType}</div>
                    </TableCell>
                    <TableCell className="align-top">
                      {truck.isRefrigerated ? (
                        <ToneBadge tone="blue">{rangeLabel(truck.minTempC, truck.maxTempC, "°C")}</ToneBadge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not refrigerated</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {truck.device ? <span className="font-mono text-xs">{truck.device.deviceCode}</span> : <span className="text-xs text-muted-foreground">None</span>}
                    </TableCell>
                    <TableCell className="align-top">
                      <MapBadge map={TRUCK_STATUS} value={truck.status} />
                    </TableCell>
                    <TableCell className="align-top">
                      {truck.activeTrip ? (
                        <>
                          <Link href={`/dashboard/cold-chain/${truck.activeTrip.shipmentId}`} className="font-medium underline-offset-4 hover:underline">
                            {truck.activeTrip.shipmentNumber}
                          </Link>
                          <div>
                            <MapBadge map={TRIP_STATUS} value={truck.activeTrip.tripStatus} />
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-72 align-top whitespace-normal">
                      <div className="flex flex-col items-start gap-2">
                        {(truck.status === "available" || truck.status === "inactive") && (
                          <InlineAction
                            action={setTruckStatusAction}
                            fields={{ truckId: truck.id, active: String(truck.status === "inactive") }}
                            label={truck.status === "inactive" ? "Activate" : "Deactivate"}
                          />
                        )}
                        <details className="w-full">
                          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Edit</summary>
                          <div className="mt-2">
                            <TruckForm truck={truck} devices={devicesFor(truck.id)} />
                          </div>
                        </details>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
