import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { formatDate, formatNumber } from "@/lib/format";
import { WarehouseApiError, warehouseApi } from "@/lib/warehouse/api";
import { DISCREPANCY_TYPE_LABELS, STORAGE_LABELS, formatDateTime, medicineLabel } from "@/lib/warehouse/format";
import {
  allocateOrderAction,
  cancelAllocationAction,
  confirmPickAction,
  declineOrderAction,
  dispatchOrderAction,
  retryHandoffAction,
} from "@/app/dashboard/warehouse/order-actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ActionForm } from "@/components/warehouse/action-form";
import { TextAreaField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import {
  ExpiryBadge,
  OrderStageBadge,
  PickStatusBadge,
  StatusBadge,
  StorageBadge,
} from "@/components/warehouse/warehouse-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

export const metadata = {
  title: "Order | PharmaTwin",
};

async function loadOrder(id) {
  try {
    return [await warehouseApi(`/warehouse/orders/${id}`), null];
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof WarehouseApiError && (error.status === 404 || error.status === 400)) notFound();
    return [null, error.message];
  }
}

export default async function OrderPage({ params }) {
  const { id } = await params;
  const [data, error] = await loadOrder(id);
  if (error) {
    return (
      <>
        <PageHeader title="Order" mock={false} />
        <LoadError message={error} />
      </>
    );
  }

  const { order, items, fulfilment, picks, shipment, discrepancies, integrations } = data;
  const stage = order.stage;
  const live = ["allocated", "picking", "ready"].includes(fulfilment?.status);
  const coldItems = items.some((item) => item.medicine.storageCondition !== "ambient");

  return (
    <>
      <PageHeader
        title={`Order ${order.orderNumber}`}
        description={`${order.pharmacy?.name ?? "Pharmacy"} · submitted ${formatDateTime(order.submittedAt)} · ${formatNumber(order.packsOrdered)} pack(s)`}
        mock={false}
      >
        <OrderStageBadge stage={stage} />
      </PageHeader>

      {order.notes && <p className={`${styles.textSm} ${styles.muted}`}>Pharmacy note: {order.notes}</p>}
      {stage === "cancelled" && <LoadError title="Order cancelled" message={order.cancelReason ?? "Cancelled."} />}

      <Card>
        <CardHeader>
          <CardTitle>Ordered products</CardTitle>
          <CardDescription>
            Available = unreserved stock in storage zones with at least {fulfilment?.minShelfDays ?? 30} days of shelf life
            (the pharmacy supply rule). Short-dated stock is not sent to pharmacies.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className={styles.right}>Ordered</TableHead>
                <TableHead className={styles.right}>Available</TableHead>
                <TableHead className={styles.right}>Short-dated</TableHead>
                <TableHead className={styles.right}>Allocated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className={styles.strong}>{medicineLabel(item.medicine)}</div>
                    <StorageBadge condition={item.medicine.storageCondition} isControlled={item.medicine.isControlled} />
                  </TableCell>
                  <TableCell className={`${styles.num} ${styles.right}`}>
                    {formatNumber(item.quantityOrdered)} {item.medicine.unit}
                  </TableCell>
                  <TableCell className={`${styles.num} ${styles.right}`}>
                    <span className={item.availablePacks < item.quantityOrdered && stage === "pending" ? styles.formError : undefined}>
                      {formatNumber(item.availablePacks)}
                    </span>
                  </TableCell>
                  <TableCell className={`${styles.num} ${styles.right} ${styles.muted}`}>{formatNumber(item.shortDatedPacks)}</TableCell>
                  <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(item.allocatedPacks)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {stage === "pending" && (
        <div className={styles.columns}>
          <Card>
            <CardHeader>
              <CardTitle>Reserve stock (FEFO)</CardTitle>
              <CardDescription>
                Reserves the earliest-expiring eligible batches for this order. Reserved stock cannot be moved, disposed
                of or given to another order. All or nothing: if any product is short, nothing is reserved.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={allocateOrderAction} submitLabel="Reserve stock" pendingLabel="Reserving…" resetOnSuccess={false}>
                <input type="hidden" name="orderId" value={order.id} />
                <div className={styles.formGrid}>
                  {items.map((item) => (
                    <TextField
                      key={item.id}
                      id={`qty-${item.id}`}
                      name={`qty:${item.id}`}
                      label={`${medicineLabel(item.medicine)} (packs)`}
                      type="number"
                      min="0"
                      max={item.quantityOrdered}
                      defaultValue={item.quantityOrdered}
                      hint={`Ordered ${item.quantityOrdered}; 0 skips it`}
                    />
                  ))}
                  <TextField id="minShelfDays" label="Minimum shelf life (days)" type="number" min="0" max="3650" defaultValue="30" />
                  <TextField id="allocate-notes" name="notes" label="Notes" placeholder="Optional" />
                </div>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Decline order</CardTitle>
              <CardDescription>The pharmacy sees the order as cancelled with your reason.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={declineOrderAction} submitLabel="Decline order" variant="destructive">
                <input type="hidden" name="orderId" value={order.id} />
                <TextAreaField id="decline-reason" name="reason" label="Reason" required minLength={3} rows={2} />
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      )}

      {fulfilment && picks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pick list</CardTitle>
            <CardDescription>
              Picked in FEFO order. At the shelf, scan the batch label (or type the batch number) and the location label
              (or type its code); both must match the reservation.
              {fulfilment.status === "ready" && " Every pick is verified: the order can be dispatched."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className={styles.right}>Packs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Verify at the shelf</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {picks.map((pick) => (
                  <TableRow key={pick.id}>
                    <TableCell className={styles.num}>{pick.sequence}</TableCell>
                    <TableCell>
                      <span className={styles.mono}>{pick.batchNumber}</span>
                      <div>
                        <ExpiryBadge expiry={pick.expiry} showDays />
                      </div>
                      {!pick.fefoCompliant && <div className={`${styles.small} ${styles.muted} ${styles.wrap}`}>{pick.fefoNote}</div>}
                    </TableCell>
                    <TableCell className={styles.mono}>
                      {pick.zoneCode} · {pick.rackCode} · {pick.locationCode}
                    </TableCell>
                    <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(pick.quantity)}</TableCell>
                    <TableCell>
                      <PickStatusBadge status={pick.status} />
                      {pick.pickedAt && (
                        <div className={`${styles.small} ${styles.muted}`}>
                          {pick.pickedVia === "qr_scan" ? "QR scan" : "typed"}, {formatDateTime(pick.pickedAt)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {pick.status === "reserved" && live ? (
                        <ActionForm action={confirmPickAction} submitLabel="Confirm pick" pendingLabel="Checking…">
                          <input type="hidden" name="orderId" value={order.id} />
                          <input type="hidden" name="pickId" value={pick.id} />
                          <div className={styles.formGrid}>
                            <TextField id={`batch-${pick.id}`} name="batchCode" label="Batch label" required autoComplete="off" placeholder="Scan or type" />
                            <TextField id={`loc-${pick.id}`} name="locationCode" label="Location" required autoComplete="off" placeholder={pick.locationCode} />
                          </div>
                        </ActionForm>
                      ) : (
                        <span className={styles.muted}>—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {live && (
        <div className={styles.columns}>
          {fulfilment.status === "ready" && (
            <Card>
              <CardHeader>
                <CardTitle>Dispatch</CardTitle>
                <CardDescription>
                  Creates the shipment the pharmacy receives (Component 4), deducts the picked stock once and hands the
                  shipment to cold-chain monitoring (Component 2) if selected.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={dispatchOrderAction} submitLabel="Dispatch order" pendingLabel="Dispatching…" resetOnSuccess={false}>
                  <input type="hidden" name="orderId" value={order.id} />
                  <div className={styles.formGrid}>
                    <label className={`${styles.checkboxRow} ${styles.fieldFull}`}>
                      <input type="checkbox" name="monitorColdChain" />
                      Hand over to cold-chain monitoring now
                      {coldItems && <span className={styles.muted}> (contains temperature-controlled items)</span>}
                    </label>
                    <p className={`${styles.hint} ${styles.fieldFull}`}>
                      The Cold Chain component assigns the sensor device and limits. Leave this unticked to set up
                      monitoring there (Cold Chain → Start monitoring).
                    </p>
                    <TextField
                      id="expectedDeliveryAt"
                      label="Expected delivery (Sri Lanka time)"
                      type="datetime-local"
                      hint="Optional; used by cold-chain delay alerts"
                    />
                    <TextField id="dispatch-notes" name="notes" label="Notes" placeholder="Vehicle, driver, delivery note" />
                  </div>
                </ActionForm>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Cancel the allocation</CardTitle>
              <CardDescription>Releases the reserved stock. The order stays pending and can be reserved again.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={cancelAllocationAction} submitLabel="Release reservation" variant="outline">
                <input type="hidden" name="orderId" value={order.id} />
                <TextField id="cancel-reason" name="reason" label="Reason" required minLength={3} />
              </ActionForm>
            </CardContent>
          </Card>
        </div>
      )}

      {shipment && (
        <ShipmentCard
          shipment={shipment}
          items={items}
          discrepancies={discrepancies}
          integrations={integrations}
        />
      )}
    </>
  );
}

function ShipmentCard({ shipment, items, discrepancies, integrations }) {
  const productOf = (medicineId) => items.find((item) => item.medicine.id === medicineId)?.medicine;
  const coldChain = integrations.find((event) => event.target === "cold_chain");
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className={styles.spread}>
            <span>
              Shipment <span className={styles.mono}>{shipment.shipmentNumber}</span>
            </span>
            <StatusBadge status={shipment.status} />
          </CardTitle>
          <CardDescription>
            Dispatched {formatDateTime(shipment.dispatchedAt)}
            {shipment.receivedAt
              ? ` · receipt confirmed by the pharmacy ${formatDateTime(shipment.receivedAt)}`
              : " · in transit: not yet confirmed by the pharmacy"}
          </CardDescription>
        </CardHeader>
        <CardContent className={styles.stack}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className={styles.right}>Shipped</TableHead>
                <TableHead className={styles.right}>Confirmed by pharmacy</TableHead>
                <TableHead>Check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipment.items.map((item) => {
                const product = productOf(item.medicineId);
                return (
                  <TableRow key={item.id}>
                    <TableCell>{product ? medicineLabel(product) : "—"}</TableCell>
                    <TableCell>
                      <span className={styles.mono}>{item.batchNumber}</span>
                      <div className={`${styles.small} ${styles.muted}`}>EXP {item.expiryDate ? formatDate(item.expiryDate) : "—"}</div>
                    </TableCell>
                    <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(item.quantityShipped)}</TableCell>
                    <TableCell className={`${styles.num} ${styles.right}`}>
                      {item.quantityAccepted == null ? "—" : formatNumber(item.quantityAccepted)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={item.verificationStatus === "discrepancy" ? "open" : item.verificationStatus === "matched" ? "received" : "pending"}
                        label={item.verificationStatus}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {shipment.receiptNotes && <p className={styles.textSm}>Pharmacy receipt note: {shipment.receiptNotes}</p>}
        </CardContent>
      </Card>

      <div className={styles.columns}>
        <Card>
          <CardHeader>
            <CardTitle>Discrepancy reports</CardTitle>
            <CardDescription>
              Raised by the pharmacy at receipt.{" "}
              <Link href="/dashboard/warehouse/discrepancies" className={styles.link}>
                Handle reports →
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            {discrepancies.length === 0 ? (
              <p className={`${styles.muted} ${styles.textSm}`}>None.</p>
            ) : (
              discrepancies.map((d) => (
                <div key={d.id} className={styles.spread}>
                  <span className={styles.textSm}>
                    <span className={styles.mono}>{d.reportNumber}</span> · {DISCREPANCY_TYPE_LABELS[d.type] ?? d.type}
                    {d.medicineName && ` · ${d.medicineName}`} {d.batchNumber && `(${d.batchNumber})`} · expected{" "}
                    {d.expectedQuantity ?? "—"}, found {d.actualQuantity ?? "—"}
                  </span>
                  <StatusBadge status={d.status} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cold-chain handoff</CardTitle>
            <CardDescription>Component 2 monitors temperature, humidity and location in transit.</CardDescription>
          </CardHeader>
          <CardContent className={styles.stack}>
            {!coldChain ? (
              <p className={`${styles.muted} ${styles.textSm}`}>No handoff recorded.</p>
            ) : (
              <>
                <div className={styles.row}>
                  <StatusBadge status={coldChain.status} />
                  <span className={`${styles.small} ${styles.muted}`}>
                    {coldChain.status === "skipped"
                      ? "Not handed over at dispatch."
                      : `${coldChain.attempts} attempt(s)${coldChain.lastAttemptAt ? `, last ${formatDateTime(coldChain.lastAttemptAt)}` : ""}`}
                  </span>
                </div>
                {coldChain.lastError && <p className={styles.formError}>{coldChain.lastError}</p>}
                {coldChain.status === "sent" && (
                  <Link href={`/dashboard/cold-chain/${shipment.id}`} className={styles.link}>
                    Open the monitored shipment in Cold Chain →
                  </Link>
                )}
                {(coldChain.status === "failed" || coldChain.status === "pending") && shipment.status === "in_transit" && (
                  <ActionForm action={retryHandoffAction} submitLabel="Retry handoff" pendingLabel="Retrying…" variant="outline">
                    <input type="hidden" name="eventId" value={coldChain.id} />
                  </ActionForm>
                )}
                {coldChain.status === "skipped" && shipment.status === "in_transit" && (
                  <Link href="/dashboard/cold-chain/start" className={styles.link}>
                    Set up monitoring in Cold Chain → Start monitoring →
                  </Link>
                )}
              </>
            )}
            <p className={`${styles.small} ${styles.muted}`}>
              Sensor devices and limits are managed by the Cold Chain component.
            </p>
            <p className={`${styles.small} ${styles.muted}`}>
              Storage needs: {[...new Set(items.map((item) => STORAGE_LABELS[item.medicine.storageCondition]))].join(", ")}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
