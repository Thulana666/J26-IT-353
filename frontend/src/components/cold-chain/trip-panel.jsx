import { startTripAction } from "@/app/dashboard/cold-chain/actions";
import { AllocateForm } from "@/components/cold-chain/allocate-form";
import { MapBadge } from "@/components/cold-chain/badges";
import { InlineAction } from "@/components/pharmacy/forms";
import { DefinitionList } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  DRIVER_STATUS,
  TRIP_STATUS,
  TRIP_STEPS,
  TRUCK_STATUS,
  TRUCK_TYPES,
  formatCoordinate,
  formatDateTime,
  formatDuration,
  formatHumidity,
  formatTemp,
  rangeLabel,
} from "@/lib/cold-chain/format";

function Stepper({ status }) {
  const current = TRIP_STEPS.indexOf(status);
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Trip progress">
      {TRIP_STEPS.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? "step" : undefined}
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            index < current && "border-emerald-500/30 text-emerald-400",
            index === current && "border-foreground/40 bg-muted font-medium text-foreground",
            index > current && "text-muted-foreground"
          )}
        >
          <span className="tabular-nums">{index + 1}.</span> {TRIP_STATUS[step][0]}
        </li>
      ))}
    </ol>
  );
}

// The trip of a monitored shipment: who drives it, in which truck, where it is
// in the workflow, and the next action for admins and warehouse staff.
//   options (managers, before the start): { drivers, trucks, devices } for allocation
export function TripPanel({ shipment: s, canManage, options }) {
  const status = s.trip.status;
  const needsCooling = s.limits.storageCondition !== "ambient";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Trip <MapBadge map={TRIP_STATUS} value={status} />
        </CardTitle>
        <CardDescription>Ready for dispatch → allocated (driver + truck) → in transit → delivered (confirmed by the driver).</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Stepper status={status} />

        <DefinitionList
          items={[
            [
              "Driver",
              s.driver ? (
                <span key="driver">
                  {s.driver.fullName} <span className="text-muted-foreground">· {s.driver.phone}</span>{" "}
                  <MapBadge map={DRIVER_STATUS} value={s.driver.status} />
                </span>
              ) : (
                "Not allocated"
              ),
            ],
            [
              "Truck",
              s.truck ? (
                <span key="truck">
                  {s.truck.registrationNumber}{" "}
                  <span className="text-muted-foreground">
                    · {TRUCK_TYPES[s.truck.truckType] ?? s.truck.truckType}
                    {s.truck.isRefrigerated && ` · ${rangeLabel(s.truck.minTempC, s.truck.maxTempC, "°C")}`}
                  </span>{" "}
                  <MapBadge map={TRUCK_STATUS} value={s.truck.status} />
                </span>
              ) : (
                "Not allocated"
              ),
            ],
            ["Sensor", s.device ? `${s.device.deviceCode}${s.device.deviceType === "simulator" ? " (simulator)" : ""}` : "None"],
            ["Allocated", s.trip.allocatedAt ? formatDateTime(s.trip.allocatedAt) : undefined],
            ["Started", s.trip.startedAt ? formatDateTime(s.trip.startedAt) : undefined],
            ["Delivered by", s.trip.deliveredAt ? (s.driver?.fullName ?? "the assigned driver") : undefined],
            ["Delivered", s.trip.deliveredAt ? `${formatDateTime(s.trip.deliveredAt)} · after ${formatDuration(s.trip.durationMinutes)}` : undefined],
            [
              "Final readings",
              s.trip.final
                ? `${formatTemp(s.trip.final.temperatureC)} · ${formatHumidity(s.trip.final.humidityPct)}` +
                  (s.trip.final.latitude !== null ? ` · ${formatCoordinate(s.trip.final.latitude)}, ${formatCoordinate(s.trip.final.longitude)}` : "") +
                  (s.trip.final.readingAt ? ` (sensor ${formatDateTime(s.trip.final.readingAt)})` : "")
                : undefined,
            ],
            ["Delivery note", s.trip.deliveryNotes ?? undefined],
          ]}
        />

        {canManage && (status === "ready_for_dispatch" || status === "allocated") && options && (
          <div className="flex flex-col gap-3 rounded-lg border p-3">
            <p className="text-sm font-medium">{status === "allocated" ? "Change the allocation" : "Allocate a driver and a truck"}</p>
            <AllocateForm
              shipmentId={s.shipmentId}
              drivers={options.drivers}
              trucks={options.trucks}
              devices={options.devices}
              limits={s.limits}
              needsCooling={needsCooling}
              current={{ driverId: s.driver?.id, truckId: s.truck?.id, deviceCode: s.device?.deviceCode }}
            />
          </div>
        )}

        {canManage && status === "allocated" && (
          <div className="flex flex-wrap items-center gap-3">
            <InlineAction
              action={startTripAction}
              fields={{ shipmentId: s.shipmentId }}
              label="Start shipment"
              pendingLabel="Starting…"
              variant="default"
              size="default"
              confirm={`Start the trip of ${s.shipmentNumber}? Readings are accepted from now on.`}
            />
            {!s.device && <span className="text-xs text-muted-foreground">Allocate a sensor device first.</span>}
          </div>
        )}

        {status === "in_transit" && (
          <p className="rounded-lg border p-3 text-sm text-muted-foreground">
            Delivery is confirmed only by the driver{s.driver ? ` (${s.driver.fullName})` : ""} in the Driver Portal; this page shows the
            result as soon as it happens.
          </p>
        )}

        {status === "delivered" && (
          <p className="text-xs text-muted-foreground">
            The trip is over; its readings, alerts and predictions stay available. The pharmacy confirms receipt of the goods in
            Pharmacy → Receiving.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
