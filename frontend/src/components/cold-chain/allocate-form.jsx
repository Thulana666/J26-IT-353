"use client";

import { useState } from "react";
import { allocateTripAction } from "@/app/dashboard/cold-chain/actions";
import { ActionForm, SelectField } from "@/components/pharmacy/forms";
import { TRUCK_TYPES, rangeLabel } from "@/lib/cold-chain/format";

// Allocate (or change) the driver, truck and sensor of a trip. Offers only
// available drivers and trucks (plus the current ones), says which trucks can
// hold the shipment's temperature range, and defaults the sensor to the one
// installed in the chosen truck. The backend re-checks everything.
//   needsCooling: the shipment's storage condition is not ambient
export function AllocateForm({ shipmentId, drivers, trucks, devices, limits, needsCooling, current = {} }) {
  const [truckId, setTruckId] = useState(current.truckId ?? "");
  const truck = trucks.find((t) => t.id === truckId);

  const suitable = (t) =>
    !needsCooling || (t.isRefrigerated && t.minTempC <= limits.tempMinC && t.maxTempC >= limits.tempMaxC);

  return (
    <ActionForm action={allocateTripAction} submitLabel={current.driverId ? "Change allocation" : "Allocate"} pendingLabel="Allocating…" resetOnSuccess={false}>
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <div className="grid gap-4 md:grid-cols-2">
        <SelectField
          id="driverId"
          label="Driver"
          required
          defaultValue={current.driverId ?? ""}
          placeholder={drivers.length ? "Choose a driver" : "No available driver"}
          options={drivers.map((d) => ({ value: d.id, label: `${d.fullName} · ${d.phone}` }))}
        />
        <SelectField
          id="truckId"
          label="Truck"
          required
          value={truckId}
          onChange={(event) => setTruckId(event.target.value)}
          placeholder={trucks.length ? "Choose a truck" : "No available truck"}
          hint={needsCooling ? `Needs refrigeration covering ${rangeLabel(limits.tempMinC, limits.tempMaxC, "°C")}.` : undefined}
          options={trucks.map((t) => ({
            value: t.id,
            disabled: !suitable(t),
            label:
              `${t.registrationNumber} · ${TRUCK_TYPES[t.truckType] ?? t.truckType}` +
              (t.isRefrigerated ? ` · ${rangeLabel(t.minTempC, t.maxTempC, "°C")}` : "") +
              (suitable(t) ? "" : " (cannot hold the range)"),
          }))}
        />
      </div>
      <SelectField
        id="deviceId"
        label="Sensor device"
        key={truckId}
        defaultValue=""
        hint={truck?.device ? `Default: ${truck.device.deviceCode}, installed in this truck.` : "This truck has no installed sensor: choose one to be able to start the trip."}
        placeholder={truck?.device ? `Truck's sensor (${truck.device.deviceCode})` : current.deviceCode ? `Keep ${current.deviceCode}` : "No sensor"}
        options={devices.map((d) => ({ value: d.id, label: `${d.deviceCode}${d.deviceType === "simulator" ? " (simulator, test data only)" : ""}` }))}
      />
    </ActionForm>
  );
}
