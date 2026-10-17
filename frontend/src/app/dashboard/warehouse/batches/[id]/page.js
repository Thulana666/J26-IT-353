import { notFound, unstable_rethrow } from "next/navigation";
import { formatDate, formatNumber } from "@/lib/format";
import { WarehouseApiError, warehouseApi } from "@/lib/warehouse/api";
import { STORAGE_LABELS, daysLabel, formatDateTime, locationPath, medicineLabel } from "@/lib/warehouse/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { regenerateQrAction } from "@/app/dashboard/warehouse/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { BatchActions, getDestinations } from "@/components/warehouse/batch-actions";
import { LoadError } from "@/components/warehouse/load-error";
import { MovementsTable } from "@/components/warehouse/movements-table";
import { PrintLabelButton } from "@/components/warehouse/print-label-button";
import {
  BatchStatusBadge,
  ExpiryBadge,
  StorageBadge,
  ZoneTypeBadge,
} from "@/components/warehouse/warehouse-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

export const metadata = {
  title: "Batch | PharmaTwin",
};

// Loads a batch; unknown or malformed ids show the Next.js 404 page.
async function loadBatch(id) {
  try {
    return [await warehouseApi(`/warehouse/batches/${id}`), null];
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof WarehouseApiError && (error.status === 404 || error.status === 400)) notFound();
    return [null, error.message];
  }
}

export default async function BatchPage({ params }) {
  const { id } = await params;
  const { isAdmin } = await getViewer();
  const [detail, error] = await loadBatch(id);
  if (error) {
    return (
      <>
        <PageHeader title="Batch" mock={false} />
        <LoadError message={error} />
      </>
    );
  }

  const { batch, expiry, qr } = detail;
  const [destinations] = await safe(getDestinations(detail));
  const totals = detail.movementTotals;

  return (
    <>
      <PageHeader
        title={`${medicineLabel(batch.medicine)} · ${batch.batchNumber}`}
        description={`${batch.medicine.dosageForm ?? "Medicine"} batch, ${formatNumber(detail.totalQuantity)} units in stock.`}
        mock={false}
      >
        <BatchStatusBadge status={batch.status} />
        <ExpiryBadge expiry={expiry} showDays />
      </PageHeader>

      {detail.requiresQuarantine && (
        <LoadError
          title="Move this stock to quarantine"
          message={`This batch is ${batch.status === "active" ? "expired" : batch.status} but some of it is still in a storage zone. Transfer it to a quarantine location.`}
        />
      )}

      <div className={`${styles.columns} ${styles.columnsWide}`}>
        <Card>
          <CardHeader>
            <CardTitle>Batch details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className={styles.definitionList}>
              <dt>Medicine</dt>
              <dd>
                {medicineLabel(batch.medicine)}
                {batch.medicine.genericName && <span className={styles.muted}> ({batch.medicine.genericName})</span>}
              </dd>
              <dt>Category</dt>
              <dd>{batch.medicine.category?.name ?? "—"}</dd>
              <dt>Storage</dt>
              <dd>
                <StorageBadge condition={batch.medicine.storageCondition} isControlled={batch.medicine.isControlled} />
              </dd>
              <dt>Batch number</dt>
              <dd className={styles.mono}>{batch.batchNumber}</dd>
              <dt>Manufactured</dt>
              <dd>{batch.manufacturingDate ? formatDate(batch.manufacturingDate) : "—"}</dd>
              <dt>Expiry</dt>
              <dd>
                {formatDate(batch.expiryDate)} <span className={styles.muted}>({daysLabel(expiry.daysToExpiry)})</span>
              </dd>
              <dt>Supplier</dt>
              <dd>{batch.supplier ?? "—"}</dd>
              <dt>Registered</dt>
              <dd>{formatDateTime(batch.createdAt)}</dd>
              <dt>Movements</dt>
              <dd className={styles.num}>
                received {formatNumber(totals.receive ?? 0)} · dispatched {formatNumber(totals.dispatch ?? 0)}
                {totals.disposal ? ` · disposed ${formatNumber(totals.disposal)}` : ""}
                {totals.adjustmentIn || totals.adjustmentOut
                  ? ` · adjusted +${totals.adjustmentIn ?? 0}/−${totals.adjustmentOut ?? 0}`
                  : ""}
              </dd>
              {batch.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{batch.notes}</dd>
                </>
              )}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>QR label</CardTitle>
            <CardDescription>The code identifies this batch; details are looked up when it is scanned.</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            {qr ? (
              <div className={styles.qrLabel}>
                {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
                <img src={qr.imageDataUrl} alt={`QR code ${qr.displayCode}`} className={styles.qrImage} />
                <span className={`${styles.mono} ${styles.strong}`}>{qr.displayCode}</span>
                <PrintLabelButton
                  imageDataUrl={qr.imageDataUrl}
                  displayCode={qr.displayCode}
                  lines={[
                    medicineLabel(batch.medicine),
                    `Batch ${batch.batchNumber}`,
                    `EXP ${batch.expiryDate}`,
                    STORAGE_LABELS[batch.medicine.storageCondition] ?? "",
                  ]}
                />
              </div>
            ) : (
              <p className={styles.muted}>This batch has no active QR label.</p>
            )}
            {batch.status !== "disposed" && (
              <ActionForm
                action={regenerateQrAction}
                submitLabel={qr ? "Issue new label" : "Generate label"}
                pendingLabel="Generating…"
                variant="outline"
              >
                <input type="hidden" name="batchId" value={batch.id} />
                {qr && (
                  <p className={styles.hint}>
                    For a damaged or lost label. The current code stops working.
                  </p>
                )}
              </ActionForm>
            )}
            {detail.qrHistory.length > 0 && (
              <p className={`${styles.small} ${styles.muted}`}>
                Deactivated codes: {detail.qrHistory.map((old) => old.code).join(", ")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stock by location</CardTitle>
          <CardDescription>
            {detail.fefo.map((position) =>
              position.isNextToDispatch
                ? `${position.warehouseCode}: next to dispatch in FEFO order.`
                : position.recommended
                  ? `${position.warehouseCode}: batch ${position.recommended.batchNumber} expires earlier and should be dispatched first.`
                  : `${position.warehouseCode}: not dispatchable (${position.ineligibleReason}).`
            ).join(" ")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {detail.stock.length === 0 ? (
            <p className={styles.muted}>No stock in any location.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Placed</TableHead>
                  <TableHead className={styles.right}>Units</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.stock.map((item) => (
                  <TableRow key={item.stockId}>
                    <TableCell className={styles.mono}>{locationPath(item)}</TableCell>
                    <TableCell>
                      <ZoneTypeBadge zoneType={item.zoneType} />
                      {item.zoneType === "storage" && <span className={styles.muted}>Storage</span>}
                    </TableCell>
                    <TableCell>{formatDate(item.placedAt)}</TableCell>
                    <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(item.quantity)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {batch.status !== "disposed" && (
        <BatchActions detail={detail} destinations={destinations ?? []} isAdmin={isAdmin} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Movement history</CardTitle>
          <CardDescription>Latest 50 movements of this batch.</CardDescription>
        </CardHeader>
        <CardContent>
          <MovementsTable movements={detail.movements} showBatch={false} />
        </CardContent>
      </Card>
    </>
  );
}
