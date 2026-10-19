"use client";

import { useState } from "react";
import { saveDriverAction, saveTruckAction } from "@/app/dashboard/cold-chain/actions";
import { ActionForm, Field, SelectField, TextField } from "@/components/pharmacy/forms";
import { TRUCK_TYPES } from "@/lib/cold-chain/format";

// Add a driver, or edit one (`driver` given). The backend validates every field.
export function DriverForm({ driver = null }) {
  return (
    <ActionForm action={saveDriverAction} submitLabel={driver ? "Save driver" : "Add driver"} pendingLabel="Saving…" resetOnSuccess={!driver}>
      {driver && <input type="hidden" name="driverId" value={driver.id} />}
      <div className="grid gap-4 md:grid-cols-3">
        <TextField id={`fullName-${driver?.id ?? "new"}`} name="fullName" label="Full name" required defaultValue={driver?.fullName} />
        <TextField id={`phone-${driver?.id ?? "new"}`} name="phone" label="Phone" required placeholder="+94 77 123 4567" defaultValue={driver?.phone} />
        <TextField id={`email-${driver?.id ?? "new"}`} name="email" label="Email (optional)" type="email" defaultValue={driver?.email ?? ""} />
        <TextField id={`licenceNumber-${driver?.id ?? "new"}`} name="licenceNumber" label="Driving licence number" required defaultValue={driver?.licenceNumber} />
        <TextField id={`licenceExpiry-${driver?.id ?? "new"}`} name="licenceExpiry" label="Licence expiry" type="date" required defaultValue={driver?.licenceExpiry} />
        <TextField id={`notes-${driver?.id ?? "new"}`} name="notes" label="Notes" defaultValue={driver?.notes ?? ""} />
      </div>
    </ActionForm>
  );
}

// Add a truck, or edit one (`truck` given). The temperature range is asked
// only for refrigerated trucks.
//   devices: sensors that can be installed (not installed in another truck)
export function TruckForm({ truck = null, devices }) {
  const [refrigerated, setRefrigerated] = useState(truck?.isRefrigerated ?? true);
  const key = truck?.id ?? "new";
  return (
    <ActionForm action={saveTruckAction} submitLabel={truck ? "Save truck" : "Add truck"} pendingLabel="Saving…" resetOnSuccess={!truck}>
      {truck && <input type="hidden" name="truckId" value={truck.id} />}
      <div className="grid gap-4 md:grid-cols-3">
        <TextField id={`registrationNumber-${key}`} name="registrationNumber" label="Registration number" required placeholder="WP LA-1234" defaultValue={truck?.registrationNumber} />
        <SelectField
          id={`truckType-${key}`}
          name="truckType"
          label="Truck type"
          defaultValue={truck?.truckType ?? "refrigerated_truck"}
          options={Object.entries(TRUCK_TYPES).map(([value, label]) => ({ value, label }))}
        />
        <Field id={`isRefrigerated-${key}`} label="Refrigeration">
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              id={`isRefrigerated-${key}`}
              type="checkbox"
              checked={refrigerated}
              onChange={(event) => setRefrigerated(event.target.checked)}
            />
            Refrigerated (has a cooling unit)
          </label>
          <input type="hidden" name="isRefrigerated" value={String(refrigerated)} />
        </Field>
        {refrigerated && (
          <>
            <TextField id={`minTempC-${key}`} name="minTempC" label="Lowest temperature it holds (°C)" type="number" step="0.5" required defaultValue={truck?.minTempC ?? ""} />
            <TextField id={`maxTempC-${key}`} name="maxTempC" label="Highest temperature it holds (°C)" type="number" step="0.5" required defaultValue={truck?.maxTempC ?? ""} />
          </>
        )}
        <SelectField
          id={`deviceId-${key}`}
          name="deviceId"
          label="Installed sensor"
          hint="Assigned to the truck's trips automatically."
          defaultValue={truck?.device?.id ?? ""}
          placeholder="None"
          options={devices.map((d) => ({ value: d.id, label: `${d.deviceCode}${d.deviceType === "simulator" ? " (simulator)" : ""}` }))}
        />
        <TextField id={`truckNotes-${key}`} name="notes" label="Notes" defaultValue={truck?.notes ?? ""} />
      </div>
    </ActionForm>
  );
}
