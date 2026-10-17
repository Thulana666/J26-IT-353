import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { DISCREPANCY_STATUS, DISCREPANCY_TYPES, ORDER_STATUS, SHIPMENT_STATUS, formatDateTime, productLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { DiscrepancyHold } from "@/components/pharmacy/discrepancy-hold";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { ShipmentReceipt } from "@/components/pharmacy/shipment-receipt";
import { DefinitionList, EmptyState, LoadError, ProductSummary, RefTag } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Shipment | Receiving | PharmaTwin" };

export default async function ShipmentPage({ params }) {
  const { id } = await params;
  const [data, error] = await safe(pharmacyApi(`/pharmacy/shipments/${id}`));
  if (error) {
    return (
      <>
        <PageHeader title="Shipment" mock={false} />
        <LoadError message={error} />
      </>
    );
  }
  const { shipment: s, order, discrepancies } = data;
  // Titled by its first medicine; other medicines in the shipment are counted.
  const medicines = [...new Set(s.items.map((i) => productLabel(i.product)))];
  const others = medicines.length - 1;

  return (
    <>
      <PharmacyRealtime tables={["shipments", "shipment_items", "shipment_discrepancies"]} />
      <PageHeader
        title={
          <>
            {medicines[0] ?? `Shipment ${s.shipmentNumber}`}
            {others > 0 && (
              <ToneBadge tone="gray" className="ml-2 align-middle">
                + {others} other item{others === 1 ? "" : "s"}
              </ToneBadge>
            )}
          </>
        }
        description={`Shipment ${s.shipmentNumber} • For order ${order.orderNumber}`}
        mock={false}
      >
        <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/pharmacy/receiving" />}>
          All shipments
        </Button>
      </PageHeader>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Shipment (from the warehouse)</CardTitle>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                ["Dispatched", `${formatDateTime(s.dispatchedAt)}${s.dispatchedBy ? ` by ${s.dispatchedBy}` : ""}`],
                ["Warehouse notes", s.notes],
                ["Items", `${s.items.length} line(s), ${s.items.reduce((t, i) => t + i.quantityShipped, 0)} pack(s)`],
                ["Received", s.receivedAt ? `${formatDateTime(s.receivedAt)}${s.receivedBy ? ` by ${s.receivedBy}` : ""}` : "Not yet"],
                ["Receipt notes", s.receiptNotes],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Original order {order.orderNumber} <StatusBadge map={ORDER_STATUS} value={order.status} />
            </CardTitle>
            <CardDescription>
              Submitted {formatDateTime(order.submittedAt)}
              {order.notes ? ` · “${order.notes}”` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {order.items.map((i) => (
                <li key={i.id} className="flex justify-between gap-2">
                  <span>{productLabel(i)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {i.quantityOrdered} {i.packUnit}(s) ordered · {s.items.filter((si) => si.orderItemId === i.id).reduce((t, si) => t + si.quantityShipped, 0)} shipped
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <ShipmentReceipt shipment={s} discrepancies={discrepancies} />

      <Card>
        <CardHeader>
          <CardTitle>Discrepancy reports</CardTitle>
          <CardDescription>Saved in the shared table, so the warehouse sees them immediately. A report never adds stock.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {discrepancies.length === 0 ? (
            <EmptyState title="No discrepancies reported" className="mx-4" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Item</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Observed</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {discrepancies.map((d) => (
                  <TableRow key={d.id} className="align-top">
                    <TableCell className="pl-4 whitespace-normal">
                      <ProductSummary product={d.product}>
                        {d.batchNumber && <div className="font-mono text-xs text-muted-foreground">batch {d.batchNumber}</div>}
                        {d.observedBarcode && <div className="font-mono text-xs text-muted-foreground">barcode {d.observedBarcode}</div>}
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <RefTag>{d.reportNumber}</RefTag>
                          <span>
                            {formatDateTime(d.reportedAt)}
                            {d.reportedBy ? ` · ${d.reportedBy}` : ""}
                          </span>
                        </div>
                      </ProductSummary>
                    </TableCell>
                    <TableCell>{DISCREPANCY_TYPES[d.type]}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.expectedQuantity ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.actualQuantity ?? "—"}</TableCell>
                    <TableCell className="max-w-72 text-xs whitespace-normal">
                      {d.notes}
                      {d.resolutionNotes && <div className="text-emerald-700">Warehouse: {d.resolutionNotes}</div>}
                    </TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge map={DISCREPANCY_STATUS} value={d.status} />
                      <DiscrepancyHold report={d} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
