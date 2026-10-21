import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { STORAGE_LABELS, medicineLabel } from "@/lib/warehouse/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import {
  createLocationAction,
  createMedicineAction,
  createRackAction,
  createWarehouseAction,
  createZoneAction,
  updateLocationAction,
  updateMedicineAction,
  updateWarehouseAction,
} from "@/app/dashboard/warehouse/config-actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { SelectField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { PrintLabelButton } from "@/components/warehouse/print-label-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/settings");

const STORAGE_OPTIONS = Object.entries(STORAGE_LABELS).map(([value, label]) => ({ value, label }));
const ACTIVE_OPTIONS = [
  { value: "true", label: "Active" },
  { value: "false", label: "Inactive" },
];
const ACCESS_OPTIONS = [
  { value: "high", label: "High (waist height, near the aisle)" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low (top shelf / deep)" },
];

export const metadata = {
  title: "Warehouse configuration | PharmaTwin",
};

function Checkbox({ name, label, defaultChecked = false }) {
  return (
    <label className={styles.checkboxRow}>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      {label}
    </label>
  );
}

export default async function WarehouseSettingsPage({ searchParams }) {
  const { label: labelLocationId } = await searchParams;
  const { isAdmin } = await getViewer();
  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Warehouse configuration" description={page.description} mock={false} />
        <LoadError title="Admins only" message="Ask an admin to change warehouses, storage locations or medicines." />
      </>
    );
  }

  const [[storage, storageError], [medicineData], [categoryData], [label]] = await Promise.all([
    safe(warehouseApi("/warehouse/storage")),
    safe(warehouseApi("/medicines")),
    safe(warehouseApi("/medicines/categories")),
    labelLocationId ? safe(warehouseApi(`/warehouse/storage/locations/${labelLocationId}/label`)) : [null, null],
  ]);
  if (storageError) {
    return (
      <>
        <PageHeader title="Warehouse configuration" description={page.description} mock={false} />
        <LoadError message={storageError} />
      </>
    );
  }

  const warehouses = storage.warehouses;
  const zones = warehouses.flatMap((w) => w.zones.map((z) => ({ ...z, warehouseCode: w.code })));
  const racks = zones.flatMap((z) => z.racks.map((r) => ({ ...r, zoneCode: z.code, warehouseCode: z.warehouseCode })));
  const locations = racks.flatMap((r) => r.locations.map((l) => ({ ...l, rackCode: r.code })));
  const medicines = medicineData?.medicines ?? [];

  return (
    <>
      <PageHeader title="Warehouse configuration" description={page.description} mock={false} />

      <div className={styles.columns}>
        <Card>
          <CardHeader>
            <CardTitle>Warehouses</CardTitle>
            <CardDescription>FEFO warning thresholds are set on the FEFO page.</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            {warehouses.map((w) => (
              <ActionForm key={w.id} action={updateWarehouseAction} submitLabel="Save" variant="outline" resetOnSuccess={false}>
                <input type="hidden" name="warehouseId" value={w.id} />
                <p className={`${styles.strong} ${styles.mono}`}>{w.code}</p>
                <div className={styles.formGrid}>
                  <TextField id={`wh-name-${w.id}`} name="name" label="Name" required defaultValue={w.name} />
                  <TextField id={`wh-address-${w.id}`} name="address" label="Address" defaultValue={w.address ?? ""} />
                  <Checkbox name="isActive" label="Active" defaultChecked={w.isActive} />
                </div>
              </ActionForm>
            ))}
            <ActionForm action={createWarehouseAction} submitLabel="Add warehouse">
              <p className={styles.strong}>New warehouse</p>
              <div className={styles.formGrid}>
                <TextField id="new-wh-code" name="code" label="Code" required maxLength={30} />
                <TextField id="new-wh-name" name="name" label="Name" required />
                <TextField id="new-wh-address" name="address" label="Address" full />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Zones</CardTitle>
            <CardDescription>
              A zone keeps one storage condition. Quarantine zones hold only quarantined, recalled or expired stock;
              controlled medicines need a secure zone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createZoneAction} submitLabel="Add zone">
              <div className={styles.formGrid}>
                <SelectField id="zone-wh" name="warehouseId" label="Warehouse" required options={warehouses.map((w) => ({ value: w.id, label: w.code }))} />
                <TextField id="zone-code" name="code" label="Code" required maxLength={20} />
                <TextField id="zone-name" name="name" label="Name" required />
                <SelectField id="zone-type" name="zoneType" label="Type" options={[{ value: "storage", label: "Storage" }, { value: "quarantine", label: "Quarantine" }]} />
                <SelectField id="zone-condition" name="storageCondition" label="Storage condition" options={STORAGE_OPTIONS} />
                <Checkbox name="isSecure" label="Secure (controlled medicines)" />
                <TextField id="zone-min" name="minTempC" label="Min °C" type="number" step="0.1" />
                <TextField id="zone-max" name="maxTempC" label="Max °C" type="number" step="0.1" />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Racks and locations</CardTitle>
            <CardDescription>Capacity is counted in storage units (e.g. cartons), the same unit as stock.</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            <ActionForm action={createRackAction} submitLabel="Add rack" variant="outline">
              <div className={styles.formGrid}>
                <SelectField id="rack-zone" name="zoneId" label="Zone" required options={zones.map((z) => ({ value: z.id, label: `${z.warehouseCode} · ${z.code} – ${z.name}` }))} />
                <TextField id="rack-code" name="code" label="Rack code" required maxLength={20} />
                <TextField id="rack-distance" name="distanceToDispatchM" label="Distance to dispatch (m)" type="number" min="0" step="0.5" defaultValue="0" />
              </div>
            </ActionForm>
            <ActionForm action={createLocationAction} submitLabel="Add location">
              <div className={styles.formGrid}>
                <SelectField id="loc-rack" name="rackId" label="Rack" required options={racks.map((r) => ({ value: r.id, label: `${r.warehouseCode} · ${r.zoneCode} · ${r.code}` }))} />
                <TextField id="loc-code" name="code" label="Location code" required maxLength={30} placeholder="e.g. A01-L2-P3" />
                <TextField id="loc-level" name="level" label="Shelf level" type="number" min="1" max="20" defaultValue="1" />
                <TextField id="loc-capacity" name="capacityUnits" label="Capacity (units)" type="number" min="1" required />
                <SelectField id="loc-access" name="accessibility" label="Accessibility" defaultValue="medium" options={ACCESS_OPTIONS} />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Edit a location</CardTitle>
            <CardDescription>Capacity cannot go below what the location holds. Inactive locations receive no stock.</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            <ActionForm action={updateLocationAction} submitLabel="Save location" resetOnSuccess={false}>
              <div className={styles.formGrid}>
                <SelectField
                  id="edit-loc"
                  name="locationId"
                  label="Location"
                  required
                  full
                  options={locations.map((l) => ({
                    value: l.id,
                    label: `${l.warehouseCode} · ${l.zoneCode} · ${l.code} (${l.occupiedUnits}/${l.capacityUnits}${l.isActive ? "" : ", inactive"})`,
                  }))}
                />
                <TextField id="edit-capacity" name="capacityUnits" label="New capacity (units)" type="number" min="1" placeholder="Unchanged" />
                <SelectField id="edit-access" name="accessibility" label="Accessibility" options={ACCESS_OPTIONS} placeholder="Unchanged" />
                <SelectField id="edit-active" name="isActive" label="Status" options={ACTIVE_OPTIONS} placeholder="Unchanged" />
              </div>
            </ActionForm>
            <form method="get" className={styles.filterBar}>
              <SelectField id="label" label="Print a location label" options={locations.map((l) => ({ value: l.id, label: `${l.warehouseCode} · ${l.code}` }))} defaultValue={labelLocationId ?? ""} placeholder="Choose…" />
              <div className={styles.actions}>
                <Button type="submit" variant="outline">Show label</Button>
              </div>
            </form>
            {label && (
              <div className={styles.qrLabel}>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                <img src={label.imageDataUrl} alt={`Location label ${label.location.code}`} className={styles.qrImage} />
                <span className={`${styles.mono} ${styles.strong}`}>{label.location.code}</span>
                <PrintLabelButton
                  imageDataUrl={label.imageDataUrl}
                  displayCode={label.location.code}
                  lines={[`${label.location.warehouseCode} · zone ${label.location.zoneCode} · rack ${label.location.rackCode}`]}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className={styles.columns}>
        <Card>
          <CardHeader>
            <CardTitle>Register a medicine</CardTitle>
            <CardDescription>
              Shared catalogue (pharmacy prices and pack sizes are set in Pharmacy → Settings). The storage condition
              decides which zones may hold it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createMedicineAction} submitLabel="Register medicine">
              <div className={styles.formGrid}>
                <TextField id="med-name" name="name" label="Name" required />
                <TextField id="med-generic" name="genericName" label="Generic name" />
                <TextField id="med-strength" name="strength" label="Strength" placeholder="e.g. 500 mg" />
                <TextField id="med-form" name="dosageForm" label="Dosage form" placeholder="tablet, injection…" />
                <TextField id="med-unit" name="unit" label="Storage unit" defaultValue="carton" />
                <SelectField
                  id="med-category"
                  name="medicineCategoryId"
                  label="Category"
                  placeholder="None"
                  options={(categoryData?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                />
                <SelectField id="med-storage" name="storageCondition" label="Storage condition" options={STORAGE_OPTIONS} />
                <Checkbox name="isControlled" label="Controlled medicine (secure storage)" />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Edit a medicine</CardTitle>
            <CardDescription>Inactive medicines cannot be ordered or registered as new batches.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateMedicineAction} submitLabel="Save medicine" resetOnSuccess={false}>
              <div className={styles.formGrid}>
                <SelectField
                  id="edit-med"
                  name="medicineId"
                  label="Medicine"
                  required
                  full
                  options={medicines.map((m) => ({
                    value: m.id,
                    label: `${medicineLabel(m)} · ${STORAGE_LABELS[m.storageCondition]}${m.isControlled ? " · controlled" : ""}${m.isActive ? "" : " · inactive"}`,
                  }))}
                />
                <SelectField id="edit-med-storage" name="storageCondition" label="Storage condition" options={STORAGE_OPTIONS} placeholder="Unchanged" />
                <SelectField
                  id="edit-med-controlled"
                  name="isControlled"
                  label="Controlled"
                  placeholder="Unchanged"
                  options={[{ value: "true", label: "Controlled (secure storage)" }, { value: "false", label: "Not controlled" }]}
                />
                <SelectField id="edit-med-active" name="isActive" label="Status" options={ACTIVE_OPTIONS} placeholder="Unchanged" />
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
