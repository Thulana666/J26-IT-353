import Link from "next/link";
import { coldChainApi } from "@/lib/cold-chain/api";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { StartMonitoringForm } from "@/components/cold-chain/start-monitoring-form";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Create shipment | PharmaTwin" };

const MANAGER_ROLES = ["admin", "warehouse_staff"];

export default async function StartMonitoringPage() {
  const { profile } = await getViewer();
  const canManage = profile?.status === "active" && MANAGER_ROLES.includes(profile.role);

  const header = (
    <PageHeader
      title="Create shipment"
      description="Take over a shipment the warehouse dispatched: set its temperature limits and expected delivery. Allocate the driver, truck and sensor on its page."
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
        <LoadError title="Not available for your role" message="Only admins and warehouse staff can create cold-chain shipments." />
      </>
    );
  }

  const [available, error] = await safe(coldChainApi("/shipments/available"));

  return (
    <>
      {header}
      {error ? (
        <LoadError title="Monitoring data could not be loaded" message={error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Dispatched orders not yet tracked</CardTitle>
            <CardDescription>
              Shipments appear here once the warehouse dispatches a pharmacy order (Warehouse → Orders). If the dispatcher handed
              it over to cold-chain tracking, it is already in Cold Chain → Shipments.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {available.shipments.length === 0 ? (
              <EmptyState title="No unmonitored shipments in transit">
                Every in-transit shipment is already monitored, or none has been dispatched yet.
              </EmptyState>
            ) : (
              <StartMonitoringForm shipments={available.shipments} />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
