import Link from "next/link";
import { recordMovementAction, setBatchStatusAction } from "@/app/dashboard/warehouse/actions";
import { warehouseApi } from "@/lib/warehouse/api";
import { ActionForm } from "@/components/warehouse/action-form";
import { SelectField, TextAreaField, TextField } from "@/components/warehouse/fields";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "./warehouse.module.css";

// Storage locations a batch may be moved to: same warehouse, matching
// storage condition, secure for controlled medicines, quarantine zones for
// blocked or expired batches, and with free space.
export async function getDestinations(detail) {
  const { batch, stock } = detail;
  const warehouseIds = [...new Set(stock.map((item) => item.warehouseId))];
  const needsQuarantine = batch.status !== "active" || detail.expiry.status === "expired";
  const lists = await Promise.all(
    warehouseIds.map((warehouseId) =>
      warehouseApi("/warehouse/storage/locations", {
        query: { warehouseId, storageCondition: batch.medicine.storageCondition, activeOnly: true, minAvailable: 1 },
      }).then((body) => body.locations)
    )
  );
  return lists
    .flat()
    .filter((location) => (location.zoneType === "quarantine") === needsQuarantine)
    .filter((location) => !batch.medicine.isControlled || location.isSecure);
}

const stockOptions = (stock) =>
  stock.map((item) => ({
    value: item.storageLocationId,
    label: `${item.locationCode} · ${item.zoneCode} · ${item.quantity} units`,
  }));

// Movement forms for one batch. `via` is "qr_scan" when opened from a scan.
export function BatchActions({ detail, destinations, isAdmin, via = "manual" }) {
  const { batch, stock } = detail;
  const inStock = stock.length > 0;
  const fefo = detail.fefo[0];
  const sources = stockOptions(stock);
  const common = (
    <>
      <input type="hidden" name="batchId" value={batch.id} />
      <input type="hidden" name="performedVia" value={via} />
    </>
  );

  if (!inStock) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No stock</CardTitle>
          <CardDescription>This batch is not stored in any location.</CardDescription>
        </CardHeader>
        {batch.status !== "disposed" && (
          <CardContent>
            <Link
              href={`/dashboard/warehouse/allocation?batchId=${batch.id}`}
              className={buttonVariants({ variant: "default" })}
            >
              Receive stock into a recommended location
            </Link>
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <div className={styles.columns}>
      <Card>
        <CardHeader>
          <CardTitle>Transfer</CardTitle>
          <CardDescription>
            Move stock between locations.{" "}
            <Link
              href={`/dashboard/warehouse/allocation?batchId=${batch.id}&excludeLocationId=${stock[0].storageLocationId}&quantity=${stock[0].quantity}`}
              className={styles.link}
            >
              Get a recommended location →
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={recordMovementAction} submitLabel="Record transfer">
            {common}
            <input type="hidden" name="movementType" value="transfer" />
            <div className={styles.formGrid}>
              <SelectField id="transfer-from" name="fromLocationId" label="From" options={sources} required />
              <SelectField
                id="transfer-to"
                name="toLocationId"
                label="To"
                required
                placeholder={destinations.length ? "Choose…" : "No compatible location with free space"}
                options={destinations.map((location) => ({
                  value: location.id,
                  label: `${location.code} · ${location.zoneCode} · ${location.availableUnits} free`,
                }))}
              />
              <TextField id="transfer-quantity" name="quantity" label="Units" type="number" min="1" required />
              <TextField id="transfer-reference" name="reference" label="Reference" placeholder="Optional" />
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dispatch</CardTitle>
          <CardDescription>
            {fefo?.isNextToDispatch
              ? "This batch is next in FEFO order."
              : fefo?.recommended
                ? `FEFO: dispatch batch ${fefo.recommended.batchNumber} (at ${fefo.recommended.locationCode}, expires ${fefo.recommended.expiryDate}) first. Dispatching this batch needs an override reason.`
                : fefo?.ineligibleReason
                  ? `This batch cannot be dispatched: ${fefo.ineligibleReason.toLowerCase()}.`
                  : "Outbound movement to a pharmacy or other destination."}
          </CardDescription>
        </CardHeader>
        <CardContent hidden={Boolean(fefo?.ineligibleReason)}>
          <ActionForm action={recordMovementAction} submitLabel="Record dispatch" variant={fefo?.isNextToDispatch ? "default" : "outline"}>
            {common}
            <input type="hidden" name="movementType" value="dispatch" />
            <div className={styles.formGrid}>
              <SelectField id="dispatch-from" name="fromLocationId" label="From" options={sources} required />
              <TextField id="dispatch-quantity" name="quantity" label="Units" type="number" min="1" required />
              <TextField id="dispatch-reference" name="reference" label="Reference" placeholder="Delivery note / destination" full />
              {fefo?.recommended && (
                <TextAreaField
                  id="dispatch-override"
                  name="fefoOverrideReason"
                  label="FEFO override reason"
                  hint="Required because an earlier-expiring batch is available (at least 10 characters). Recorded for compliance."
                  rows={2}
                />
              )}
            </div>
          </ActionForm>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Stock correction or disposal</CardTitle>
              <CardDescription>Admins only. A reason is required and recorded.</CardDescription>
            </CardHeader>
            <CardContent className={styles.stack}>
              <ActionForm action={recordMovementAction} submitLabel="Record adjustment" variant="outline">
                {common}
                <input type="hidden" name="movementType" value="adjustment" />
                <div className={styles.formGrid}>
                  <SelectField id="adjust-location" name="adjustLocationId" label="Location" options={sources} required />
                  <SelectField
                    id="adjust-direction"
                    name="adjustDirection"
                    label="Change"
                    options={[
                      { value: "out", label: "Decrease (count lower)" },
                      { value: "in", label: "Increase (count higher)" },
                    ]}
                  />
                  <TextField id="adjust-quantity" name="quantity" label="Units" type="number" min="1" required />
                  <TextField id="adjust-notes" name="notes" label="Reason" required placeholder="e.g. cycle count difference" />
                </div>
              </ActionForm>
              <ActionForm action={recordMovementAction} submitLabel="Record disposal" variant="destructive">
                {common}
                <input type="hidden" name="movementType" value="disposal" />
                <div className={styles.formGrid}>
                  <SelectField id="dispose-from" name="fromLocationId" label="From" options={sources} required />
                  <TextField id="dispose-quantity" name="quantity" label="Units" type="number" min="1" required />
                  <TextField id="dispose-notes" name="notes" label="Reason" required placeholder="e.g. expired, destroyed per SOP" full />
                </div>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Batch status</CardTitle>
              <CardDescription>
                Quarantined and recalled batches are excluded from FEFO picking and must be stored in quarantine
                zones.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={setBatchStatusAction} submitLabel="Update status" variant="outline" resetOnSuccess={false}>
                <input type="hidden" name="batchId" value={batch.id} />
                <div className={styles.formGrid}>
                  <SelectField
                    id="batch-status"
                    name="status"
                    label="Status"
                    defaultValue={batch.status}
                    options={[
                      { value: "active", label: "Active" },
                      { value: "quarantined", label: "Quarantined" },
                      { value: "recalled", label: "Recalled" },
                    ]}
                  />
                  <TextField id="batch-notes" name="notes" label="Notes" defaultValue={batch.notes ?? ""} />
                </div>
              </ActionForm>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
