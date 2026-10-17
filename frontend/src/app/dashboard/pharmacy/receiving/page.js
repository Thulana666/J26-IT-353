import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { SHIPMENT_STATUS, formatDateTime, formatNum, packLabel, productLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/pharmacy/badges";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { EmptyState, LoadError, ProductSummary, RefTag } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Receiving | Pharmacy | PharmaTwin" };

// A shipment is shown by the medicines it carries, not its reference number.
function itemsTitle(items) {
  const names = [...new Set(items.map((i) => productLabel(i.product)))];
  if (names.length === 0) return "No items";
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
}

export default async function ReceivingPage() {
  const [[incoming, error], [history]] = await Promise.all([
    safe(pharmacyApi("/pharmacy/shipments", { query: { status: "in_transit" } })),
    safe(pharmacyApi("/pharmacy/shipments", { query: { status: "received,received_with_discrepancies", limit: 30 } })),
  ]);

  return (
    <>
      <PharmacyRealtime tables={["shipments"]} />
      <PageHeader title="Receiving" description="Shipments dispatched by the warehouse appear here automatically. Inspect each delivery against its order, then confirm receipt or report the disputed items." mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {incoming.shipments.length === 0 && <EmptyState title="No shipments on the way" className="md:col-span-2 xl:col-span-3">Dispatched orders appear here immediately.</EmptyState>}
            {incoming.shipments.map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle className="flex items-start justify-between gap-2">
                    <span>{itemsTitle(s.items)}</span>
                    <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
                  </CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-1">
                    <RefTag>{s.shipmentNumber}</RefTag>
                    <RefTag>{s.orderNumber}</RefTag>
                    <span>
                      dispatched {formatDateTime(s.dispatchedAt)}
                      {s.dispatchedBy ? ` by ${s.dispatchedBy}` : ""}
                    </span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <ul className="flex flex-col gap-2 text-sm">
                    {s.items.map((i) => (
                      <li key={i.id} className="flex justify-between gap-2">
                        <ProductSummary product={i.product} />
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {i.quantityShipped} {packLabel(i.product, i.quantityShipped)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {s.discrepancyCount > 0 && (
                    <p className="text-xs text-amber-900">{s.discrepancyCount} discrepancy report(s) recorded</p>
                  )}
                  <Button nativeButton={false} render={<Link href={`/dashboard/pharmacy/receiving/${s.id}`} />}>Inspect and receive</Button>
                </CardContent>
              </Card>
            ))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Received shipments</CardTitle>
              <CardDescription>Shipment history is kept with counts per item and discrepancy reports.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {(history?.shipments ?? []).length === 0 ? (
                <EmptyState title="Nothing received yet" className="mx-4" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Items</TableHead>
                      <TableHead>Received</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead className="text-right">Packs accepted / shipped</TableHead>
                      <TableHead>Discrepancies</TableHead>
                      <TableHead className="pr-4">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.shipments.map((s) => (
                      <TableRow key={s.id} className="align-top">
                        <TableCell className="pl-4 whitespace-normal">
                          <Link href={`/dashboard/pharmacy/receiving/${s.id}`} className="flex flex-col gap-1 hover:underline">
                            {s.items.slice(0, 3).map((i) => (
                              <ProductSummary key={i.id} product={i.product} />
                            ))}
                          </Link>
                          {s.items.length > 3 && <div className="text-xs text-muted-foreground">+ {s.items.length - 3} more item(s)</div>}
                          <div className="mt-1 flex flex-wrap gap-1">
                            <RefTag>{s.shipmentNumber}</RefTag>
                            <RefTag>{s.orderNumber}</RefTag>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{formatDateTime(s.receivedAt)}</TableCell>
                        <TableCell className="text-xs">{s.receivedBy ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNum(s.items.reduce((t, i) => t + (i.quantityAccepted ?? 0), 0))} / {formatNum(s.items.reduce((t, i) => t + i.quantityShipped, 0))}
                        </TableCell>
                        <TableCell className="text-xs">
                          {s.discrepancyCount === 0 ? "—" : `${s.discrepancyCount} (${s.openDiscrepancyCount} open)`}
                        </TableCell>
                        <TableCell className="pr-4">
                          <StatusBadge map={SHIPMENT_STATUS} value={s.status} />
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
