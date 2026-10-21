import Link from "next/link";
import { setDeviceActiveAction } from "@/app/dashboard/cold-chain/actions";
import { coldChainApi } from "@/lib/cold-chain/api";
import { formatDateTime } from "@/lib/cold-chain/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { ToneBadge } from "@/components/cold-chain/badges";
import { RegisterDeviceForm, RotateKeyButton } from "@/components/cold-chain/device-forms";
import { PageHeader } from "@/components/dashboard/page-header";
import { InlineAction } from "@/components/pharmacy/forms";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Sensor devices | PharmaTwin" };

const MANAGER_ROLES = ["admin", "warehouse_staff"];

const READING_EXAMPLE = `POST /api/cold-chain/readings
X-Device-Id: ESP32-001
X-Device-Key: <key shown once at registration>
Content-Type: application/json

{ "recordedAt": "2026-10-17T03:00:00Z", "temperatureC": 5.4, "humidityPct": 62.1,
  "latitude": 6.9271, "longitude": 79.8612, "speedKmh": 38.5 }`;

export default async function DevicesPage() {
  const { profile } = await getViewer();
  const canView = profile?.status === "active" && MANAGER_ROLES.includes(profile.role);
  const isAdmin = canView && profile.role === "admin";

  const header = (
    <PageHeader title="Sensor devices" description="ESP32 loggers and development simulators that send cold-chain readings." mock={false}>
      <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/cold-chain/start" />}>
        Start monitoring
      </Button>
    </PageHeader>
  );
  if (!canView) {
    return (
      <>
        {header}
        <LoadError title="Not available for your role" message="Only admins and warehouse staff can see sensor devices." />
      </>
    );
  }

  const [data, error] = await safe(coldChainApi("/devices"));

  return (
    <>
      {header}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Register a device</CardTitle>
            <CardDescription>
              Each device gets its own key, shown once. The backend stores only its hash, never the Supabase secret key; a device
              can only post readings for the shipment it is assigned to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RegisterDeviceForm />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>
            {isAdmin ? "Deactivate a device to refuse its readings; rotate its key if it may have leaked." : "Only admins can register devices or change their keys."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <LoadError title="Devices could not be loaded" message={error} />
          ) : data.devices.length === 0 ? (
            <EmptyState title="No devices registered yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last reading</TableHead>
                  <TableHead>Reporting for</TableHead>
                  {isAdmin && <TableHead>Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <div className="font-mono text-sm">{device.deviceCode}</div>
                      {device.name && <div className="text-xs text-muted-foreground">{device.name}</div>}
                    </TableCell>
                    <TableCell>
                      {device.deviceType === "simulator" ? <ToneBadge tone="violet">Simulator</ToneBadge> : <ToneBadge tone="blue">ESP32</ToneBadge>}
                    </TableCell>
                    <TableCell>{device.isActive ? <ToneBadge tone="green">Active</ToneBadge> : <ToneBadge tone="gray">Deactivated</ToneBadge>}</TableCell>
                    <TableCell>
                      {device.lastSeenAt ? (
                        <span className="text-sm">{formatDateTime(device.lastSeenAt)}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {device.activeShipment ? (
                        <Link href={`/dashboard/cold-chain/${device.activeShipment.shipmentId}`} className="font-medium underline-offset-4 hover:underline">
                          {device.activeShipment.shipmentNumber}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">Free</span>
                      )}
                    </TableCell>
                    {isAdmin && (
                      <TableCell className="min-w-64 align-top whitespace-normal">
                        <div className="flex flex-col items-start gap-2">
                          <InlineAction
                            action={setDeviceActiveAction}
                            fields={{ deviceId: device.id, isActive: String(!device.isActive) }}
                            label={device.isActive ? "Deactivate" : "Activate"}
                            confirm={device.isActive ? `Deactivate ${device.deviceCode}? Its readings are refused until it is activated again.` : undefined}
                          />
                          <RotateKeyButton deviceId={device.id} deviceCode={device.deviceCode} />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Device API</CardTitle>
          <CardDescription>
            What an ESP32 sends to the backend. Readings may be batched as {"{ \"readings\": [...] }"} (up to 300). Drop readings from the
            device buffer on any 2xx or 4xx answer; retry only on 5xx or no answer. Full contract: docs/component-2-cold-chain.md.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{READING_EXAMPLE}</pre>
        </CardContent>
      </Card>
    </>
  );
}
