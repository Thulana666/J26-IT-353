import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { RETURN_REASONS, RETURN_STATUS, formatDateTime, productLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/pharmacy/badges";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { ReturnBuilder } from "@/components/pharmacy/return-builder";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Returns | Pharmacy | PharmaTwin" };

export default async function ReturnsPage() {
  const [[returns, error], [inventory]] = await Promise.all([
    safe(pharmacyApi("/pharmacy/returns", { query: { limit: 50 } })),
    safe(pharmacyApi("/pharmacy/inventory")),
  ]);
  // Unreserved stock, expired batches first.
  const eligible = (inventory?.products ?? [])
    .flatMap((p) => p.batches)
    .filter((b) => b.quantityAvailable > 0)
    .sort((a, b) => (a.expiryDate < b.expiryDate ? -1 : 1));

  return (
    <>
      <PharmacyRealtime tables={["return_requests"]} />
      <PageHeader title="Returns" description="Return expired, damaged, recalled or excess stock to the warehouse." mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>New return</CardTitle>
              <CardDescription>
                Returned units are held (not sellable) while the request is pending. They leave this pharmacy&apos;s stock only when the warehouse
                confirms it received them; a rejection releases them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ReturnBuilder eligible={eligible} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Return requests</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              {returns.returns.length === 0 ? (
                <EmptyState title="No returns yet" className="mx-4" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Return</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Requested</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead className="pr-4">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {returns.returns.map((r) => (
                      <TableRow key={r.id} className="align-top">
                        <TableCell className="pl-4 font-mono text-xs">{r.returnNumber}</TableCell>
                        <TableCell className="text-xs">
                          <ul>
                            {r.items.map((i) => (
                              <li key={i.id}>
                                {i.quantity} × {productLabel(i.product)} <span className="font-mono">({i.batch?.batchNumber})</span> · {RETURN_REASONS[i.reason]}
                                {i.restockedPacks > 0 && <span className="text-emerald-700"> · {i.restockedPacks} pack(s) restocked</span>}
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                        <TableCell className="text-xs">
                          {formatDateTime(r.requestedAt)}
                          {r.requestedBy && <div className="text-muted-foreground">{r.requestedBy}</div>}
                        </TableCell>
                        <TableCell className="max-w-64 text-xs whitespace-normal">
                          {r.reviewNotes && <div>Review: {r.reviewNotes}</div>}
                          {r.receivedAt && <div>Received {formatDateTime(r.receivedAt)}</div>}
                          {r.receiptNotes && <div className="text-muted-foreground">{r.receiptNotes}</div>}
                        </TableCell>
                        <TableCell className="pr-4">
                          <StatusBadge map={RETURN_STATUS} value={r.status} />
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
