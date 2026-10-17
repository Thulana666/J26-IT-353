import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { EXPIRY_LABELS, daysLabel, medicineLabel } from "@/lib/warehouse/format";
import { getMedicines, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { receiveBatchAction, recordMovementAction } from "@/app/dashboard/warehouse/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { SelectField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { BatchStatusBadge, ExpiryBadge, StorageBadge } from "@/components/warehouse/warehouse-badges";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/allocation");

const FACTOR_LABELS = {
  expiryAccessibility: "Expiry ↔ accessibility",
  capacityFit: "Capacity fit",
  consolidation: "Consolidation",
  zoneEfficiency: "Zone efficiency",
};

const REJECTION_LABELS = {
  storage_condition: "wrong storage condition",
  security: "not a secure zone",
  zone_type: "wrong zone type",
  capacity: "not enough free space",
  inactive: "inactive",
};

export const metadata = {
  title: `Receive & Allocate | PharmaTwin`,
};

export default async function AllocationPage({ searchParams }) {
  const params = await searchParams;
  const [[warehouses, warehousesError], [medicines], [existing]] = await Promise.all([
    safe(getWarehouses()),
    safe(getMedicines()),
    params.batchId ? safe(warehouseApi(`/warehouse/batches/${params.batchId}`)) : [null, null],
  ]);

  const warehouseId = params.warehouseId ?? existing?.stock[0]?.warehouseId ?? warehouses?.[0]?.id;
  const quantity = params.quantity;
  const ready = warehouseId && quantity && (existing || (params.medicineId && params.expiryDate && params.batchNumber));

  const [result, recommendError] = ready
    ? await safe(
        warehouseApi("/warehouse/spatial/recommend", {
          method: "POST",
          body: existing
            ? { warehouseId, quantity, batchId: existing.batch.id, excludeLocationId: params.excludeLocationId }
            : {
                warehouseId,
                quantity,
                medicineId: params.medicineId,
                expiryDate: params.expiryDate,
                batchNumber: params.batchNumber,
              },
        })
      )
    : [null, null];

  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false} />
      {warehousesError && <LoadError message={warehousesError} />}

      <Card>
        <CardHeader>
          <CardTitle>{existing ? "Batch to place" : "Incoming batch"}</CardTitle>
          <CardDescription>
            {existing
              ? params.excludeLocationId
                ? "Re-slotting: find a better location for stock of this batch."
                : "Receive stock of a registered batch."
              : "Enter the delivery details. The batch gets a QR label when it is received."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {existing ? (
            <ExistingBatchForm existing={existing} params={params} warehouses={warehouses ?? []} warehouseId={warehouseId} />
          ) : (
            <form method="get" className={styles.form}>
              <div className={styles.formGrid}>
                <SelectField
                  id="warehouseId"
                  label="Warehouse"
                  required
                  defaultValue={warehouseId ?? ""}
                  options={(warehouses ?? []).map((w) => ({ value: w.id, label: `${w.code} – ${w.name}` }))}
                />
                <SelectField
                  id="medicineId"
                  label="Medicine"
                  required
                  defaultValue={params.medicineId ?? ""}
                  placeholder="Choose…"
                  options={(medicines ?? []).map((m) => ({ value: m.id, label: medicineLabel(m) }))}
                />
                <TextField id="batchNumber" label="Batch number" required maxLength={60} defaultValue={params.batchNumber} />
                <TextField id="quantity" label="Units received" type="number" min="1" required defaultValue={quantity} />
                <TextField id="expiryDate" label="Expiry date" type="date" required defaultValue={params.expiryDate} />
                <TextField id="manufacturingDate" label="Manufacturing date" type="date" defaultValue={params.manufacturingDate} />
                <TextField id="supplier" label="Supplier" defaultValue={params.supplier} full />
              </div>
              <div className={styles.actions}>
                <Button type="submit">Get recommendations</Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {recommendError && <LoadError title="No recommendation" message={recommendError} />}
      {result && <Recommendations result={result} existing={existing} params={params} />}
    </>
  );
}

function ExistingBatchForm({ existing, params, warehouses, warehouseId }) {
  const { batch } = existing;
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <Link href={`/dashboard/warehouse/batches/${batch.id}`} className={`${styles.link} ${styles.mono}`}>
          {batch.batchNumber}
        </Link>
        <span>{medicineLabel(batch.medicine)}</span>
        <BatchStatusBadge status={batch.status} />
        <ExpiryBadge expiry={existing.expiry} showDays />
        <StorageBadge condition={batch.medicine.storageCondition} isControlled={batch.medicine.isControlled} />
      </div>
      <form method="get" className={styles.filterBar}>
        <input type="hidden" name="batchId" value={batch.id} />
        {params.excludeLocationId && <input type="hidden" name="excludeLocationId" value={params.excludeLocationId} />}
        <SelectField
          id="warehouseId"
          label="Warehouse"
          defaultValue={warehouseId ?? ""}
          options={warehouses.map((w) => ({ value: w.id, label: w.code }))}
        />
        <TextField id="quantity" label="Units" type="number" min="1" required defaultValue={params.quantity} />
        <div className={styles.actions}>
          <Link href="/dashboard/warehouse/allocation" className={buttonVariants({ variant: "ghost" })}>
            New batch instead
          </Link>
          <Button type="submit">Get recommendations</Button>
        </div>
      </form>
    </div>
  );
}

function Recommendations({ result, existing, params }) {
  const candidates = [result.recommended, ...result.alternatives].filter(Boolean);
  const { assessment, algorithm } = result;
  const rejectedCounts = Object.entries(result.summary.rejectedByReason);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recommended storage locations</CardTitle>
        <CardDescription>
          {result.quantity} units of {medicineLabel(result.medicine)} in {result.warehouse.code} · expires{" "}
          {formatDate(result.batch.expiryDate)} ({daysLabel(assessment.daysToExpiry)},{" "}
          {EXPIRY_LABELS[assessment.expiryStatus]}) · {result.summary.feasible} of {result.summary.candidates} locations
          are suitable.
          {assessment.requiresQuarantine && " This batch must go to a quarantine zone."}
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.stack}>
        <p className={`${styles.small} ${styles.muted}`}>
          Method: {algorithm.description} Weights:{" "}
          {Object.entries(algorithm.weights)
            .map(([factor, weight]) => `${FACTOR_LABELS[factor] ?? factor} ${Math.round(weight * 100)}%`)
            .join(", ")}
          . A transparent rule-based heuristic (v{algorithm.version}), not a trained model; scores rank the options and are
          not probabilities.
        </p>

        {result.message && <p className={styles.formError}>{result.message}</p>}

        {candidates.map((candidate) => (
          <div key={candidate.locationId} className={styles.recommendation} data-best={candidate.rank === 1}>
            <div className={styles.spread}>
              <div>
                <div className={styles.row}>
                  <span className={`${styles.mono} ${styles.strong}`}>{candidate.code}</span>
                  {candidate.rank === 1 && <span className={styles.formSuccess}>Recommended</span>}
                </div>
                <div className={`${styles.small} ${styles.muted}`}>
                  Zone {candidate.zoneCode} · rack {candidate.rackCode} · {candidate.accessibility} accessibility ·{" "}
                  {candidate.distanceToDispatchM} m to dispatch · {formatNumber(candidate.availableUnits)} free →{" "}
                  {formatNumber(candidate.availableAfterUnits)} after ({candidate.utilizationAfterPct}% used)
                </div>
              </div>
              <span className={styles.score} title="Weighted score out of 100">
                {candidate.score}
              </span>
            </div>
            <div className={styles.factorGrid}>
              {Object.entries(candidate.factors).map(([factor, value]) => (
                <div key={factor} className={styles.field}>
                  <span className={styles.small}>{FACTOR_LABELS[factor] ?? factor}</span>
                  <div className={styles.meterRow}>
                    <div className={styles.meter}>
                      <div className={styles.meterFill} style={{ width: `${Math.round(value * 100)}%` }} />
                    </div>
                    <span className={styles.meterValue}>{value.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
            <ul className={styles.reasons}>
              {candidate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <PlaceForm candidate={candidate} result={result} existing={existing} params={params} />
          </div>
        ))}

        {rejectedCounts.length > 0 && (
          <details className={styles.small}>
            <summary className={styles.muted}>
              Excluded locations:{" "}
              {rejectedCounts.map(([reason, count]) => `${count} ${REJECTION_LABELS[reason] ?? reason}`).join(", ")}
            </summary>
            <ul className={styles.reasons}>
              {result.rejected.map((rejected) => (
                <li key={rejected.locationId}>
                  <span className={styles.mono}>{rejected.code}</span>: {rejected.reasons.join("; ")}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

// Puts the stock in this location: receive (new or registered batch) or transfer (re-slotting).
function PlaceForm({ candidate, result, existing, params }) {
  const quantity = String(result.quantity);
  if (existing && params.excludeLocationId) {
    return (
      <ActionForm action={recordMovementAction} submitLabel={`Move ${quantity} units here`} variant="outline">
        <input type="hidden" name="batchId" value={existing.batch.id} />
        <input type="hidden" name="movementType" value="transfer" />
        <input type="hidden" name="fromLocationId" value={params.excludeLocationId} />
        <input type="hidden" name="toLocationId" value={candidate.locationId} />
        <input type="hidden" name="quantity" value={quantity} />
      </ActionForm>
    );
  }
  return (
    <ActionForm
      action={receiveBatchAction}
      submitLabel={`Receive ${quantity} units here`}
      pendingLabel="Receiving…"
      variant={candidate.rank === 1 ? "default" : "outline"}
    >
      {existing ? (
        <input type="hidden" name="batchId" value={existing.batch.id} />
      ) : (
        <>
          <input type="hidden" name="medicineId" value={params.medicineId} />
          <input type="hidden" name="batchNumber" value={params.batchNumber} />
          <input type="hidden" name="expiryDate" value={params.expiryDate} />
          <input type="hidden" name="manufacturingDate" value={params.manufacturingDate ?? ""} />
          <input type="hidden" name="supplier" value={params.supplier ?? ""} />
        </>
      )}
      <input type="hidden" name="toLocationId" value={candidate.locationId} />
      <input type="hidden" name="quantity" value={quantity} />
      <input type="hidden" name="reference" value={params.reference ?? ""} />
    </ActionForm>
  );
}
