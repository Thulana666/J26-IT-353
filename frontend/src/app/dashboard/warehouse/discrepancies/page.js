import Link from "next/link";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { DISCREPANCY_TYPE_LABELS, formatDateTime, medicineLabel } from "@/lib/warehouse/format";
import { safe } from "@/lib/warehouse/page-data";
import { updateDiscrepancyAction } from "@/app/dashboard/warehouse/order-actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { TextAreaField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { StatusBadge } from "@/components/warehouse/warehouse-badges";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/discrepancies");
const BASE_PATH = "/dashboard/warehouse/discrepancies";
const FILTERS = { open: "open,acknowledged", resolved: "resolved", all: undefined };

export const metadata = {
  title: "Discrepancies | PharmaTwin",
};

export default async function DiscrepanciesPage({ searchParams }) {
  const { show } = await searchParams;
  const filter = show in FILTERS ? show : "open";
  const [result, error] = await safe(warehouseApi("/warehouse/discrepancies", { query: { status: FILTERS[filter] } }));

  return (
    <>
      <PageHeader title="Discrepancy reports" description={page.description} mock={false} />
      <nav className={styles.row} aria-label="Filter">
        {Object.keys(FILTERS).map((key) => (
          <Link key={key} href={`${BASE_PATH}?show=${key}`} className={buttonVariants({ variant: filter === key ? "default" : "outline", size: "sm" })}>
            {key === "open" ? "Open" : key === "resolved" ? "Resolved" : "All"}
          </Link>
        ))}
      </nav>
      {error ? (
        <LoadError message={error} />
      ) : result.discrepancies.length === 0 ? (
        <Card>
          <CardContent>
            <p className={styles.muted}>No reports here.</p>
          </CardContent>
        </Card>
      ) : (
        result.discrepancies.map((d) => (
          <Card key={d.id}>
            <CardHeader>
              <CardTitle className={styles.spread}>
                <span>
                  <span className={styles.mono}>{d.reportNumber}</span> · {DISCREPANCY_TYPE_LABELS[d.type] ?? d.type}
                </span>
                <StatusBadge status={d.status} />
              </CardTitle>
              <CardDescription>
                {d.pharmacyName} · shipment <span className={styles.mono}>{d.shipmentNumber}</span> · order{" "}
                <Link href={`/dashboard/warehouse/orders/${d.orderId}`} className={`${styles.link} ${styles.mono}`}>
                  {d.orderNumber}
                </Link>{" "}
                · reported {formatDateTime(d.reportedAt)} {d.reportedBy && `by ${d.reportedBy}`}
              </CardDescription>
            </CardHeader>
            <CardContent className={styles.stack}>
              <dl className={styles.definitionList}>
                <dt>Product</dt>
                <dd>{d.product ? medicineLabel(d.product) : d.observedBarcode ? `Unknown item (barcode ${d.observedBarcode})` : "—"}</dd>
                <dt>Batch</dt>
                <dd className={styles.mono}>{d.batchNumber ?? d.observedBatchNumber ?? "—"}</dd>
                <dt>Packs</dt>
                <dd className={styles.num}>
                  expected {d.expectedQuantity ?? "—"}, found {d.actualQuantity ?? "—"}
                  {d.heldUnits > 0 && ` · ${d.heldUnits} unit(s) held at the pharmacy`}
                </dd>
                {d.notes && (
                  <>
                    <dt>Pharmacy notes</dt>
                    <dd>{d.notes}</dd>
                  </>
                )}
                {d.resolutionNotes && (
                  <>
                    <dt>Resolution</dt>
                    <dd>
                      {d.resolutionNotes} {d.resolvedAt && <span className={styles.muted}>({formatDateTime(d.resolvedAt)})</span>}
                    </dd>
                  </>
                )}
              </dl>
              {d.status !== "resolved" && (
                <div className={styles.columns}>
                  {d.status === "open" && (
                    <ActionForm action={updateDiscrepancyAction} submitLabel="Acknowledge" variant="outline">
                      <input type="hidden" name="discrepancyId" value={d.id} />
                      <input type="hidden" name="action" value="acknowledge" />
                      <TextField id={`ack-${d.id}`} name="notes" label="Note to the pharmacy" placeholder="Optional, e.g. investigating" />
                    </ActionForm>
                  )}
                  <ActionForm action={updateDiscrepancyAction} submitLabel="Resolve">
                    <input type="hidden" name="discrepancyId" value={d.id} />
                    <input type="hidden" name="action" value="resolve" />
                    <TextAreaField
                      id={`resolve-${d.id}`}
                      name="notes"
                      label="How it was resolved"
                      required
                      minLength={3}
                      rows={2}
                      hint="The pharmacy then releases or writes off any held stock."
                    />
                  </ActionForm>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </>
  );
}
