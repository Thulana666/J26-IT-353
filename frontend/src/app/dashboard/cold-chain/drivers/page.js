import Link from "next/link";
import { linkDriverAccountAction, setDriverStatusAction, unlinkDriverAccountAction } from "@/app/dashboard/cold-chain/actions";
import { coldChainApi } from "@/lib/cold-chain/api";
import { DRIVER_STATUS, TRIP_STATUS, formatDate } from "@/lib/cold-chain/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { MapBadge, ToneBadge } from "@/components/cold-chain/badges";
import { DriverForm } from "@/components/cold-chain/fleet-forms";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm, InlineAction, TextField } from "@/components/pharmacy/forms";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Drivers | PharmaTwin" };

function LicenceState({ daysLeft }) {
  if (daysLeft < 0) return <ToneBadge tone="red">Expired</ToneBadge>;
  if (daysLeft <= 30) return <ToneBadge tone="amber">Expires in {daysLeft} d</ToneBadge>;
  return null;
}

export default async function DriversPage() {
  const { profile } = await getViewer();
  const canManage = profile?.status === "active" && ["admin", "warehouse_staff"].includes(profile.role);
  const header = <PageHeader title="Drivers" description="Drivers for cold-chain trips: contact, licence and availability." mock={false} />;
  if (!canManage) {
    return (
      <>
        {header}
        <LoadError title="Not available for your role" message="Only admins and warehouse staff manage drivers." />
      </>
    );
  }

  const [data, error] = await safe(coldChainApi("/drivers"));
  return (
    <>
      {header}
      <Card>
        <CardHeader>
          <CardTitle>Add driver</CardTitle>
          <CardDescription>A driver can be allocated to one live trip at a time, and only with a valid licence.</CardDescription>
        </CardHeader>
        <CardContent>
          <DriverForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Drivers</CardTitle>
          <CardDescription>
            Assigned and on-trip statuses follow the trip workflow; deactivate drivers who are not working. Link each driver to the
            account they signed up with: drivers confirm deliveries and report issues in the Driver Portal (/driver).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <LoadError title="Drivers could not be loaded" message={error} />
          ) : data.drivers.length === 0 ? (
            <EmptyState title="No drivers yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Licence</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Portal account</TableHead>
                  <TableHead>Current trip</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.drivers.map((driver) => (
                  <TableRow key={driver.id}>
                    <TableCell className="align-top">
                      <div className="font-medium">{driver.fullName}</div>
                      <div className="text-xs text-muted-foreground">{[driver.phone, driver.email].filter(Boolean).join(" · ")}</div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="font-mono text-xs">{driver.licenceNumber}</div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        valid until {formatDate(driver.licenceExpiry)} <LicenceState daysLeft={driver.licenceDaysLeft} />
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <MapBadge map={DRIVER_STATUS} value={driver.status} />
                    </TableCell>
                    <TableCell className="min-w-56 align-top whitespace-normal">
                      {driver.account ? (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-sm">{driver.account.email}</span>
                          <InlineAction
                            action={unlinkDriverAccountAction}
                            fields={{ driverId: driver.id }}
                            label="Unlink"
                            confirm={`Unlink ${driver.account.email}? It becomes a plain user account and loses Driver Portal access.`}
                          />
                        </div>
                      ) : (
                        <ActionForm action={linkDriverAccountAction} submitLabel="Link account" pendingLabel="Linking…" variant="outline" size="sm" className="flex flex-col gap-2">
                          <input type="hidden" name="driverId" value={driver.id} />
                          <TextField id={`account-${driver.id}`} name="email" type="email" required label="Driver's sign-in email" placeholder="driver@example.com" />
                        </ActionForm>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {driver.activeTrip ? (
                        <Link href={`/dashboard/cold-chain/${driver.activeTrip.shipmentId}`} className="font-medium underline-offset-4 hover:underline">
                          {driver.activeTrip.shipmentNumber}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                      {driver.activeTrip && (
                        <div>
                          <MapBadge map={TRIP_STATUS} value={driver.activeTrip.tripStatus} />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-72 align-top whitespace-normal">
                      <div className="flex flex-col items-start gap-2">
                        {(driver.status === "available" || driver.status === "inactive") && (
                          <InlineAction
                            action={setDriverStatusAction}
                            fields={{ driverId: driver.id, active: String(driver.status === "inactive") }}
                            label={driver.status === "inactive" ? "Activate" : "Deactivate"}
                          />
                        )}
                        <details className="w-full">
                          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Edit</summary>
                          <div className="mt-2">
                            <DriverForm driver={driver} />
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
