import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { EXPIRY_STATUS, STOCK_STATUS, formatDate, formatMoney, formatNum, productLabel, unitLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { selectClass } from "@/components/pharmacy/forms";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const metadata = { title: "Inventory | Pharmacy | PharmaTwin" };

export default async function InventoryPage({ searchParams }) {
  const { q = "", stock = "all", expiry = "all" } = await searchParams;
  const [data, error] = await safe(pharmacyApi("/pharmacy/inventory", { query: { q, stock, expiry } }));

  return (
    <>
      <PageHeader title="Inventory" description="Stock by product and batch. Batches are listed earliest expiry first (FEFO)." mock={false} />
      <form className="flex flex-wrap items-end gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Product, brand, manufacturer, batch or barcode" className="w-80" aria-label="Search" />
        <select name="stock" defaultValue={stock} className={`${selectClass} w-auto`} aria-label="Stock status">
          <option value="all">All stock levels</option>
          <option value="low">Low</option>
          <option value="out">Out of stock</option>
          <option value="ok">In stock</option>
        </select>
        <select name="expiry" defaultValue={expiry} className={`${selectClass} w-auto`} aria-label="Expiry">
          <option value="all">Any expiry</option>
          <option value="near_expiry">Has near-expiry stock</option>
          <option value="expired">Has expired stock</option>
        </select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
        {(q || stock !== "all" || expiry !== "all") && (
          <Button variant="ghost" nativeButton={false} render={<Link href="/dashboard/pharmacy/inventory" />}>
            Clear
          </Button>
        )}
      </form>

      {error ? (
        <LoadError message={error} />
      ) : (
        <>
          <PharmacyRealtime tables={["pharmacy_inventory"]} />
          <p className="text-sm text-muted-foreground">
            {formatNum(data.totals.products)} product(s) · {formatNum(data.totals.units)} units on hand · stock value {formatMoney(data.totals.value)} (at cost)
          </p>
          <Card>
            <CardContent className="px-0">
              {data.products.length === 0 ? (
                <EmptyState title="No products match" className="mx-4">
                  Stock appears here after a shipment is received.
                </EmptyState>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Product</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead className="text-right" title="Set aside for pending return requests">
                        Reserved <span className="font-normal text-muted-foreground">(returns)</span>
                      </TableHead>
                      <TableHead className="text-right" title="Held out of sale by open discrepancy reports">
                        Held <span className="font-normal text-muted-foreground">(discrepancy)</span>
                      </TableHead>
                      <TableHead>Batches (FEFO order)</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="pr-4 text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.products.map((p) => (
                      <TableRow key={p.product.id} className="align-top">
                        <TableCell className="pl-4">
                          <Link href={`/dashboard/pharmacy/inventory/${p.product.id}`} className="font-medium hover:underline">
                            {productLabel(p.product)}
                          </Link>
                          <div className="text-xs text-muted-foreground">
                            {[p.product.brandName, p.product.manufacturer, p.product.dosageForm].filter(Boolean).join(" · ")}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <StatusBadge map={STOCK_STATUS} value={p.stockStatus} />
                            {p.hasExpired && <ToneBadge tone="red">Expired stock</ToneBadge>}
                            {!p.hasExpired && p.hasNearExpiry && <ToneBadge tone="amber">Near expiry</ToneBadge>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNum(p.totals.available)} <span className="text-xs text-muted-foreground">{unitLabel(p.product)}</span>
                          {p.lowStockThreshold !== null && <div className="text-xs text-muted-foreground">threshold {formatNum(p.lowStockThreshold)}</div>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNum(p.totals.reserved)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", p.totals.held > 0 && "font-medium text-amber-800")}>
                          {formatNum(p.totals.held ?? 0)}
                        </TableCell>
                        <TableCell>
                          <ul className="flex flex-col gap-1 text-xs">
                            {p.batches.filter((b) => b.quantityOnHand > 0).map((b) => (
                              <li key={b.inventoryId} className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono">{b.batchNumber}</span>
                                <span className="tabular-nums">{formatNum(b.quantityAvailable)}</span>
                                <span className="text-muted-foreground">exp {formatDate(b.expiryDate)}</span>
                                {b.expiryStatus !== "ok" && <StatusBadge map={EXPIRY_STATUS} value={b.expiryStatus} />}
                                {b.batchStatus !== "active" && <ToneBadge tone="red">{b.batchStatus}</ToneBadge>}
                              </li>
                            ))}
                            {p.batches.every((b) => b.quantityOnHand === 0) && <li className="text-muted-foreground">No stock in any batch</li>}
                          </ul>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(p.sellingPrice)}</TableCell>
                        <TableCell className="pr-4 text-right tabular-nums">{formatMoney(p.totals.value)}</TableCell>
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
