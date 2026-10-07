import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { EXPIRY_LABELS, medicineLabel } from "@/lib/warehouse/format";
import { getMedicines, getViewer, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { dispatchFefoAction, updateThresholdsAction } from "@/app/dashboard/warehouse/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { SelectField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { MovementsTable } from "@/components/warehouse/movements-table";
import { BatchStatusBadge, ExpiryBadge } from "@/components/warehouse/warehouse-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/fefo");

export const metadata = {
  title: `FEFO | PharmaTwin`,
};

export default async function FefoPage({ searchParams }) {
  const params = await searchParams;
  const { isAdmin } = await getViewer();
  const pickRequested = Boolean(params.warehouseId && params.medicineId && params.quantity);

  const [[alerts, alertsError], [compliance], [warehouses], [medicines], [pick, pickError]] = await Promise.all([
    safe(warehouseApi("/warehouse/fefo/alerts")),
    safe(warehouseApi("/warehouse/fefo/compliance", { query: { days: 30 } })),
    safe(getWarehouses()),
    safe(getMedicines()),
    pickRequested
      ? safe(
          warehouseApi("/warehouse/fefo/pick", {
            query: { warehouseId: params.warehouseId, medicineId: params.medicineId, quantity: params.quantity },
          })
        )
      : [null, null],
  ]);

  if (alertsError) {
    return (
      <>
        <PageHeader title="FEFO management" description={page.description} mock={false} />
        <LoadError message={alertsError} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="FEFO management" description={page.description} mock={false} />

      <Card>
        <CardHeader>
          <CardTitle>Expiry alerts</CardTitle>
          <CardDescription>
            {alerts.counts.expired} expired · {alerts.counts.critical} critical · {alerts.counts.near_expiry} near
            expiry. Thresholds:{" "}
            {alerts.thresholds
              .map((t) => `${t.warehouseCode} critical ≤ ${t.criticalExpiryDays} d, near ≤ ${t.nearExpiryDays} d`)
              .join("; ")}
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BatchAlertTable batches={alerts.alerts} empty="No batches are expired or near expiry." />
        </CardContent>
      </Card>

      {alerts.quarantineRequired.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Move to quarantine</CardTitle>
            <CardDescription>
              Expired, quarantined or recalled stock that is still in a storage zone. Open the batch to transfer it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BatchAlertTable batches={alerts.quarantineRequired} />
          </CardContent>
        </Card>
      )}

      <div className={`${styles.columns} ${styles.columnsWide}`}>
        <Card>
          <CardHeader>
            <CardTitle>FEFO pick list</CardTitle>
            <CardDescription>
              Which batches to pick for an outbound order: earliest expiry first. Expired, quarantined and recalled
              stock is never picked.
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            <form method="get" className={styles.filterBar}>
              <SelectField
                id="warehouseId"
                label="Warehouse"
                required
                defaultValue={params.warehouseId ?? warehouses?.[0]?.id ?? ""}
                options={(warehouses ?? []).map((w) => ({ value: w.id, label: w.code }))}
              />
              <SelectField
                id="medicineId"
                label="Medicine"
                required
                defaultValue={params.medicineId ?? ""}
                placeholder="Choose…"
                options={(medicines ?? []).map((m) => ({ value: m.id, label: medicineLabel(m) }))}
              />
              <TextField id="quantity" label="Units" type="number" min="1" required defaultValue={params.quantity} />
              <div className={styles.actions}>
                <Button type="submit" variant="outline">
                  Build pick list
                </Button>
              </div>
            </form>
            {pickError && <LoadError title="Pick list could not be built" message={pickError} />}
            {pick && <PickList pick={pick} />}
          </CardContent>
        </Card>

        <div className={styles.stack}>
          <Card>
            <CardHeader>
              <CardTitle>FEFO compliance</CardTitle>
              <CardDescription>Dispatches in the last 30 days.</CardDescription>
            </CardHeader>
            <CardContent>
              {compliance ? (
                <dl className={styles.definitionList}>
                  <dt>Dispatches</dt>
                  <dd className={styles.num}>
                    {compliance.dispatches} ({formatNumber(compliance.units)} units)
                  </dd>
                  <dt>Followed FEFO</dt>
                  <dd className={styles.num}>{compliance.compliant}</dd>
                  <dt>Overrides</dt>
                  <dd className={styles.num}>{compliance.overrides}</dd>
                  <dt>Compliance rate</dt>
                  <dd className={`${styles.num} ${styles.strong}`}>
                    {compliance.complianceRatePct === null ? "No dispatches yet" : `${compliance.complianceRatePct}%`}
                  </dd>
                </dl>
              ) : (
                <p className={styles.muted}>Compliance could not be loaded.</p>
              )}
            </CardContent>
          </Card>

          {isAdmin && warehouses?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Warning thresholds</CardTitle>
                <CardDescription>Days before expiry at which batches are flagged.</CardDescription>
              </CardHeader>
              <CardContent className={styles.stack}>
                {warehouses.map((warehouse) => (
                  <ActionForm key={warehouse.id} action={updateThresholdsAction} submitLabel="Save" resetOnSuccess={false}>
                    <input type="hidden" name="warehouseId" value={warehouse.id} />
                    <p className={styles.strong}>{warehouse.code}</p>
                    <div className={styles.formGrid}>
                      <TextField
                        id={`critical-${warehouse.id}`}
                        name="criticalExpiryDays"
                        label="Critical (days)"
                        type="number"
                        min="1"
                        defaultValue={warehouse.criticalExpiryDays}
                      />
                      <TextField
                        id={`near-${warehouse.id}`}
                        name="nearExpiryDays"
                        label="Near expiry (days)"
                        type="number"
                        min="2"
                        defaultValue={warehouse.nearExpiryDays}
                      />
                    </div>
                  </ActionForm>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {compliance?.recentOverrides.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent FEFO overrides</CardTitle>
            <CardDescription>Dispatches of a later-expiring batch while an earlier one was available.</CardDescription>
          </CardHeader>
          <CardContent>
            <MovementsTable movements={compliance.recentOverrides} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function BatchAlertTable({ batches, empty }) {
  if (batches.length === 0) return <p className={`${styles.muted} ${styles.textSm}`}>{empty}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead>Locations</TableHead>
          <TableHead className={styles.right}>Units</TableHead>
          <TableHead>Recommended action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <TableRow key={`${batch.warehouseId}:${batch.batchId}`}>
            <TableCell>
              <Link href={`/dashboard/warehouse/batches/${batch.batchId}`} className={`${styles.link} ${styles.mono}`}>
                {batch.batchNumber}
              </Link>
              <div className={`${styles.small} ${styles.muted}`}>{medicineLabel(batch)}</div>
              {batch.batchStatus !== "active" && <BatchStatusBadge status={batch.batchStatus} />}
            </TableCell>
            <TableCell>
              <ExpiryBadge expiry={batch.expiry} showDays />
              <div className={`${styles.small} ${styles.muted}`}>{formatDate(batch.expiryDate)}</div>
            </TableCell>
            <TableCell className={`${styles.mono} ${styles.small}`}>
              {batch.locations.map((location) => `${location.code} (${location.quantity})`).join(", ")}
            </TableCell>
            <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(batch.quantity)}</TableCell>
            <TableCell className={`${styles.wrap} ${styles.small}`}>{batch.action}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PickList({ pick }) {
  return (
    <div className={styles.stack}>
      <p className={styles.textSm}>
        {medicineLabel(pick.medicine)}: {formatNumber(pick.allocated)} of {formatNumber(pick.requested)} units allocated
        from {formatNumber(pick.available)} eligible.
        {pick.shortfall > 0 && <span className={styles.formError}> Short by {formatNumber(pick.shortfall)} units.</span>}
      </p>
      {pick.lines.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Pick from</TableHead>
              <TableHead className={styles.right}>Pick</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pick.lines.map((line, index) => (
              <TableRow key={line.stockId}>
                <TableCell className={styles.num}>{index + 1}</TableCell>
                <TableCell className={styles.mono}>{line.batchNumber}</TableCell>
                <TableCell>
                  <ExpiryBadge expiry={line.expiry} showDays />
                </TableCell>
                <TableCell className={styles.mono}>{line.locationCode}</TableCell>
                <TableCell className={`${styles.num} ${styles.right}`}>
                  {formatNumber(line.pickQuantity)} of {formatNumber(line.quantity)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {pick.excluded.length > 0 && (
        <p className={`${styles.small} ${styles.muted}`}>
          Not picked:{" "}
          {pick.excluded
            .map((item) => `${item.batchNumber} at ${item.locationCode} (${item.reason}, ${EXPIRY_LABELS[item.expiry.status]})`)
            .join("; ")}
          .
        </p>
      )}
      {pick.shortfall === 0 && pick.lines.length > 0 && (
        <ActionForm action={dispatchFefoAction} submitLabel="Dispatch these picks" pendingLabel="Dispatching…">
          <input type="hidden" name="warehouseId" value={pick.warehouse.id} />
          <input type="hidden" name="medicineId" value={pick.medicine.id} />
          <input type="hidden" name="quantity" value={pick.requested} />
          <div className={styles.formGrid}>
            <TextField id="dispatch-reference" name="reference" label="Reference" placeholder="Delivery note / order no." />
            <TextField id="dispatch-notes" name="notes" label="Notes" placeholder="Optional" />
          </div>
        </ActionForm>
      )}
    </div>
  );
}
