import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { DISCREPANCY_STATUS, DISCREPANCY_TYPES, formatDateTime } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { DiscrepancyHold } from "@/components/pharmacy/discrepancy-hold";
import { StatusBadge } from "@/components/pharmacy/badges";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { EmptyState, LoadError, ProductSummary, RefTag } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Discrepancies | Pharmacy | PharmaTwin" };

const FILTERS = { open: "open,acknowledged", resolved: "resolved", all: "" };

export default async function DiscrepanciesPage({ searchParams }) {
  const { show = "open" } = await searchParams;
  const [data, error] = await safe(pharmacyApi("/pharmacy/discrepancies", { query: { status: FILTERS[show] ?? FILTERS.open, limit: 200 } }));

  return (
    <>
      <PharmacyRealtime tables={["shipment_discrepancies"]} />
      <PageHeader title="Discrepancies" description="Missing, excess, damaged or incorrect items reported to the warehouse, and the warehouse's resolution." mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Reports</CardTitle>
              <CardDescription className="flex flex-wrap gap-1">
                {Object.keys(FILTERS).map((key) => (
                  <Button key={key} size="xs" variant={show === key ? "default" : "outline"} nativeButton={false} render={<Link href={`?show=${key}`} />}>
                    {key === "open" ? "Open" : key === "resolved" ? "Resolved" : "All"}
                  </Button>
                ))}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {data.discrepancies.length === 0 ? (
                <EmptyState title="No reports" className="mx-4" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Item</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Exp. / actual</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="pr-4">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.discrepancies.map((d) => (
                      <TableRow key={d.id} className="align-top">
                        <TableCell className="pl-4 whitespace-normal">
                          <ProductSummary product={d.product}>
                            {d.batchNumber && <div className="font-mono text-xs text-muted-foreground">batch {d.batchNumber}</div>}
                            {!d.product && d.observedBarcode && <div className="font-mono text-xs text-muted-foreground">barcode {d.observedBarcode}</div>}
                            <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                              <RefTag>{d.reportNumber}</RefTag>
                              <Link href={`/dashboard/pharmacy/receiving/${d.shipmentId}`} className="hover:underline">
                                <RefTag>{d.shipmentNumber}</RefTag>
                              </Link>
                              <span>{formatDateTime(d.reportedAt)}</span>
                            </div>
                          </ProductSummary>
                        </TableCell>
                        <TableCell>{DISCREPANCY_TYPES[d.type]}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.expectedQuantity ?? "—"} / {d.actualQuantity ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-72 text-xs whitespace-normal">
                          {d.notes}
                          {d.resolutionNotes && <div className="mt-1 text-emerald-700">Warehouse: {d.resolutionNotes}</div>}
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
          <Card>
            <CardHeader>
              <CardTitle>Report a discrepancy</CardTitle>
              <CardDescription>
                Open the shipment on the Receiving page and use <strong>Report discrepancy / Scan item</strong> for the disputed item, or{" "}
                <strong>Report issue</strong> on its row. The report is linked to the shipment, its order and the warehouse&apos;s batch details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/pharmacy/receiving" />}>
                Go to Receiving
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
