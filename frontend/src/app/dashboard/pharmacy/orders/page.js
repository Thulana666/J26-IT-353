import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { ORDER_STATUS, SHIPMENT_STATUS, formatDateTime, packsAndUnits, productLabel } from "@/lib/pharmacy/format";
import { cancelOrderAction } from "@/app/dashboard/pharmacy/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/pharmacy/badges";
import { ActionForm, TextField } from "@/components/pharmacy/forms";
import { OrderBuilder } from "@/components/pharmacy/order-builder";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { RunForecastButton } from "@/components/pharmacy/run-forecast-button";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Orders | Pharmacy | PharmaTwin" };

export default async function OrdersPage() {
  const [[orders, error], [recs, recError], [settings]] = await Promise.all([
    safe(pharmacyApi("/pharmacy/orders", { query: { limit: 50 } })),
    safe(pharmacyApi("/pharmacy/recommendations", { query: { status: "pending" } })),
    safe(pharmacyApi("/pharmacy/settings")),
  ]);

  return (
    <>
      <PharmacyRealtime tables={["purchase_orders", "reorder_recommendations"]} />
      <PageHeader title="Orders" description="Order stock from the warehouse. Quantities start from the rule-based reorder recommendations (Q*)." mock={false}>
        <RunForecastButton variant="outline" label="Refresh recommendations" />
      </PageHeader>
      {error || recError ? (
        <LoadError message={error ?? recError} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>New order</CardTitle>
              <CardDescription>
                Recommended Q* = max(0, target stock − inventory position), rounded to whole packs (a rule-based order-up-to quantity, not the
                classical EOQ formula). Products at their reorder point are pre-selected. Accepting, editing or rejecting a line is recorded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Remount when the recommendations change (recalculation or decisions). */}
              <OrderBuilder
                key={recs.recommendations.map((r) => r.id).join(",")}
                recommendations={recs.recommendations}
                products={(settings?.products ?? []).map((p) => p.product)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Orders</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {orders.orders.length === 0 ? (
                <EmptyState title="No orders yet" className="mx-4" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Order</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Shipment</TableHead>
                      <TableHead className="pr-4" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.orders.map((o) => (
                      <TableRow key={o.id} className="align-top">
                        <TableCell className="pl-4">
                          <div className="font-mono text-xs font-medium">{o.orderNumber}</div>
                          {o.notes && <div className="max-w-56 text-xs whitespace-normal text-muted-foreground">{o.notes}</div>}
                        </TableCell>
                        <TableCell className="text-xs">
                          <ul>
                            {o.items.map((i) => (
                              <li key={i.id}>
                                {productLabel(i.product)} · {packsAndUnits(i.quantityOrdered, i.product)}
                                {i.recommendationId && <span className="text-muted-foreground"> · from recommendation</span>}
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(o.submittedAt)}
                          {o.createdBy && <div className="text-muted-foreground">{o.createdBy}</div>}
                        </TableCell>
                        <TableCell>
                          <StatusBadge map={ORDER_STATUS} value={o.status} />
                          {o.cancelReason && <div className="mt-1 max-w-48 text-xs whitespace-normal text-muted-foreground">{o.cancelReason}</div>}
                        </TableCell>
                        <TableCell>
                          {o.shipment ? (
                            <Link href={`/dashboard/pharmacy/receiving/${o.shipment.id}`} className="flex flex-col gap-1 text-xs hover:underline">
                              <span className="font-mono">{o.shipment.shipmentNumber}</span>
                              <StatusBadge map={SHIPMENT_STATUS} value={o.shipment.status} />
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="pr-4">
                          {o.status === "submitted" && (
                            <details>
                              <summary className="cursor-pointer text-xs text-muted-foreground">Cancel…</summary>
                              <ActionForm action={cancelOrderAction} submitLabel="Cancel order" variant="destructive" size="sm" className="mt-2 w-56">
                                <input type="hidden" name="orderId" value={o.id} />
                                <TextField id={`reason-${o.id}`} name="reason" label="Reason" required />
                              </ActionForm>
                            </details>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
