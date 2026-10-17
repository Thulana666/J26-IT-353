import Link from "next/link";
import { coldChainApi } from "@/lib/cold-chain/api";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { StartMonitoringForm } from "@/components/cold-chain/start-monitoring-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Start monitoring | PharmaTwin" };

const MANAGER_ROLES = ["admin", "warehouse_staff"];

export default async function StartMonitoringPage() {
  const { profile } = await getViewer();
  const canManage = profile?.status === "active" && MANAGER_ROLES.includes(profile.role);
  const isAdmin = canManage && profile.role === "admin";

  const header = (
    <PageHeader
      title="Start monitoring"
      description="Assign a sensor device to a shipment in transit and set the limits its readings are checked against."
      mock={false}
    >
      <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/cold-chain" />}>
        All shipments
      </Button>
    </PageHeader>
  );
  if (!canManage) {
    return (
      <>
        {header}
        <LoadError title="Not available for your role" message="Only admins and warehouse staff can start monitoring a shipment." />
      </>
    );
  }

  const [[available, availableError], [devicesData, devicesError]] = await Promise.all([
    safe(coldChainApi("/shipments/available")),
    safe(coldChainApi("/devices")),
  ]);
  const error = availableError ?? devicesError;
  // Free devices: active and not reporting for another active shipment.
  const devices = (devicesData?.devices ?? []).filter((d) => d.isActive && !d.activeShipment);

  return (
    <>
      {header}
      {error ? (
        <LoadError title="Monitoring data could not be loaded" message={error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>New monitored shipment</CardTitle>
            <CardDescription>
              Shipments appear here once the warehouse dispatches a pharmacy order. Readings are accepted from the dispatch time.{" "}
              {devices.length === 0 && (
                <>
                  No free device:{" "}
                  {isAdmin ? (
                    <Link href="/dashboard/cold-chain/devices" className="font-medium underline-offset-4 hover:underline">
                      register one →
                    </Link>
                  ) : (
                    "ask an admin to register one, or start without a device."
                  )}
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {available.shipments.length === 0 ? (
              <EmptyState title="No unmonitored shipments in transit">
                Every in-transit shipment is already monitored, or none has been dispatched yet.
              </EmptyState>
            ) : (
              <StartMonitoringForm shipments={available.shipments} devices={devices} />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
