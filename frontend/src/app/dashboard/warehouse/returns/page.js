import Link from "next/link";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { RETURN_REASON_LABELS, formatDateTime, medicineLabel } from "@/lib/warehouse/format";
import { safe } from "@/lib/warehouse/page-data";
import { receiveReturnAction, reviewReturnAction } from "@/app/dashboard/warehouse/order-actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { StatusBadge } from "@/components/warehouse/warehouse-badges";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/returns");
const BASE_PATH = "/dashboard/warehouse/returns";
const FILTERS = { open: "pending,approved", done: "received,rejected", all: undefined };

export const metadata = {
  title: "Returns | PharmaTwin",
};

// Locations a returned batch may be restocked into (the database checks again):
// matching storage condition, secure for controlled medicines, quarantine for
// blocked or expired batches, room for the whole packs.
function restockOptions(item, locations, today) {
  const product = item.product;
  if (!product || !item.batch) return [];
  const packs = item.quantity / (product.unitsPerPack || 1);
  if (!Number.isInteger(packs)) return [];
  const quarantine = item.batch.status !== "active" || item.batch.expiryDate < today;
  return locations
    .filter(
      (l) =>
        l.isActive &&
        l.storageCondition === product.storageCondition &&
        (!product.isControlled || l.isSecure) &&
        (l.zoneType === "quarantine") === quarantine &&
        l.availableUnits >= packs
    )
    .map((l) => ({ value: l.id, label: `${l.code} · ${l.zoneCode} · ${l.availableUnits} free` }));
}

export default async function ReturnsPage({ searchParams }) {
  const { show } = await searchParams;
  const filter = show in FILTERS ? show : "open";
  const [[result, error], [locations]] = await Promise.all([
    safe(warehouseApi("/warehouse/returns", { query: { status: FILTERS[filter] } })),
    safe(warehouseApi("/warehouse/storage/locations", { query: { activeOnly: true } }).then((b) => b.locations)),
  ]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());

  return (
    <>
      <PageHeader title="Returns from pharmacies" description={page.description} mock={false} />
      <nav className={styles.row} aria-label="Filter">
        {Object.keys(FILTERS).map((key) => (
          <Link key={key} href={`${BASE_PATH}?show=${key}`} className={buttonVariants({ variant: filter === key ? "default" : "outline", size: "sm" })}>
            {key === "open" ? "To handle" : key === "done" ? "Handled" : "All"}
          </Link>
        ))}
      </nav>
      {error ? (
        <LoadError message={error} />
      ) : result.returns.length === 0 ? (
        <Card>
          <CardContent>
            <p className={styles.muted}>No returns here.</p>
          </CardContent>
        </Card>
      ) : (
        result.returns.map((r) => (
          <Card key={r.id}>
            <CardHeader>
              <CardTitle className={styles.spread}>
                <span>
                  <span className={styles.mono}>{r.returnNumber}</span> · {r.pharmacyName}
                </span>
                <StatusBadge status={r.status} />
              </CardTitle>
              <CardDescription>
                Requested {formatDateTime(r.requestedAt)} {r.requestedBy && `by ${r.requestedBy}`}
                {r.notes && ` · "${r.notes}"`}
                {r.reviewNotes && ` · review: ${r.reviewNotes}`}
                {r.receivedAt && ` · received ${formatDateTime(r.receivedAt)}`}
              </CardDescription>
            </CardHeader>
            <CardContent className={styles.stack}>
              {r.status === "pending" || r.status === "approved" ? (
                <ActionForm action={receiveReturnAction} submitLabel="Confirm received" pendingLabel="Receiving…">
                  <input type="hidden" name="returnId" value={r.id} />
                  <ReturnItems items={r.items} locations={locations ?? []} today={today} editable />
                  <TextField id={`receive-notes-${r.id}`} name="notes" label="Receipt notes" placeholder="Optional" />
                </ActionForm>
              ) : (
                <ReturnItems items={r.items} locations={[]} today={today} editable={false} />
              )}
              {(r.status === "pending" || r.status === "approved") && (
                <div className={styles.columns}>
                  {r.status === "pending" && (
                    <ActionForm action={reviewReturnAction} submitLabel="Approve return" variant="outline">
                      <input type="hidden" name="returnId" value={r.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <TextField id={`approve-${r.id}`} name="notes" label="Note" placeholder="Optional" />
                    </ActionForm>
                  )}
                  <ActionForm action={reviewReturnAction} submitLabel="Reject return" variant="destructive">
                    <input type="hidden" name="returnId" value={r.id} />
                    <input type="hidden" name="decision" value="reject" />
                    <TextField
                      id={`reject-${r.id}`}
                      name="notes"
                      label="Reason (the pharmacy's reservation is released)"
                      required
                      minLength={3}
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

function ReturnItems({ items, locations, today, editable }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead>Batch</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead className={styles.right}>Units</TableHead>
          <TableHead>{editable ? "Restock into" : "Restocked"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const options = editable ? restockOptions(item, locations, today) : [];
          const packs = item.product ? item.quantity / (item.product.unitsPerPack || 1) : null;
          return (
            <TableRow key={item.id}>
              <TableCell>{item.product ? medicineLabel(item.product) : "—"}</TableCell>
              <TableCell className={styles.mono}>{item.batch?.batchNumber ?? "—"}</TableCell>
              <TableCell>{RETURN_REASON_LABELS[item.reason] ?? item.reason}</TableCell>
              <TableCell className={`${styles.num} ${styles.right}`}>
                {item.quantity}
                {Number.isInteger(packs) && <div className={`${styles.small} ${styles.muted}`}>{packs} pack(s)</div>}
              </TableCell>
              <TableCell>
                {!editable ? (
                  <span className={styles.textSm}>{item.restockedPacks ? `${item.restockedPacks} pack(s)` : "—"}</span>
                ) : options.length ? (
                  <select name={`restock:${item.id}`} className={styles.select} aria-label="Restock location" defaultValue="">
                    <option value="">Do not restock</option>
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`${styles.small} ${styles.muted}`}>
                    {Number.isInteger(packs) ? "No compatible location" : "Not whole packs; cannot restock"}
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
