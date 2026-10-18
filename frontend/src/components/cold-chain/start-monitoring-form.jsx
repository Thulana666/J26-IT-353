"use client";

import { useState } from "react";
import { startMonitoringAction } from "@/app/dashboard/cold-chain/actions";
import { ActionForm, Field, SelectField, TextField } from "@/components/pharmacy/forms";
import { STORAGE_LABELS, formatDateTime } from "@/lib/cold-chain/format";

const valueOf = (number) => (number === null || number === undefined ? "" : String(number));

// Create a cold-chain shipment from a dispatched order: choose the shipment,
// check the limits (pre-filled from the items' storage condition) and the
// expected delivery time. It becomes "ready for dispatch"; the driver, truck
// and sensor are allocated on its page. The backend re-checks every value.
//   shipments: GET /api/cold-chain/shipments/available
export function StartMonitoringForm({ shipments }) {
  const [shipmentId, setShipmentId] = useState(shipments[0]?.shipmentId ?? "");
  const shipment = shipments.find((s) => s.shipmentId === shipmentId);
  const limits = shipment?.defaultLimits;

  return (
    <ActionForm action={startMonitoringAction} submitLabel="Create shipment" pendingLabel="Creating…" resetOnSuccess={false}>
      <div className="grid gap-4">
        <SelectField
          id="shipmentId"
          label="Shipment in transit"
          value={shipmentId}
          onChange={(event) => setShipmentId(event.target.value)}
          options={shipments.map((s) => ({
            value: s.shipmentId,
            label: `${s.shipmentNumber} · ${s.originName ?? "?"} → ${s.destinationName ?? "?"} · dispatched ${formatDateTime(s.dispatchedAt)}`,
          }))}
        />
      </div>

      {shipment && (
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Items</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
            {shipment.items.map((item, index) => (
              <li key={index}>
                {[item.medicineName, item.strength].filter(Boolean).join(" ")} · batch {item.batchNumber ?? "—"} · {item.quantityShipped} pack(s) ·{" "}
                {STORAGE_LABELS[item.storageCondition] ?? item.storageCondition ?? "storage condition not set"}
              </li>
            ))}
          </ul>
          {shipment.warnings.map((warning) => (
            <p key={warning} className="mt-2 text-amber-300">
              {warning}
            </p>
          ))}
        </div>
      )}

      {/* Keyed by shipment so the defaults refill when another shipment is chosen. */}
      <fieldset key={shipmentId} className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">
          Limits{" "}
          <span className="font-normal text-muted-foreground">
            · defaults for {STORAGE_LABELS[limits?.storageCondition] ?? "ambient"} items; set them from the product labels
          </span>
        </legend>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <TextField id="tempMinC" label="Min temperature (°C)" type="number" step="0.1" required defaultValue={valueOf(limits?.tempMinC)} />
          <TextField id="tempMaxC" label="Max temperature (°C)" type="number" step="0.1" required defaultValue={valueOf(limits?.tempMaxC)} />
          <TextField id="humidityMinPct" label="Min humidity (%RH)" type="number" step="1" min="0" max="100" placeholder="none" defaultValue={valueOf(limits?.humidityMinPct)} />
          <TextField id="humidityMaxPct" label="Max humidity (%RH)" type="number" step="1" min="0" max="100" placeholder="none" defaultValue={valueOf(limits?.humidityMaxPct)} />
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-3">
        <TextField id="expectedDeliveryAt" label="Expected delivery (Sri Lanka time)" type="datetime-local" hint="Optional; used to detect delays." />
        <TextField id="readingIntervalSeconds" label="Reading interval (seconds)" type="number" min="5" max="3600" step="1" defaultValue="60" hint="How often the device sends a reading." />
        <Field id="isTest" label="Data">
          <label className="flex h-8 items-center gap-2 text-sm">
            <input id="isTest" type="checkbox" name="isTest" value="true" />
            Test shipment (simulated data, excluded from research)
          </label>
        </Field>
      </div>
    </ActionForm>
  );
}
