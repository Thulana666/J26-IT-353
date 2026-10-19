import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { RECOMMENDATION_STATUS, coverLabel, formatDate, formatNum, formatQty, packsAndUnits, productLabel, unitLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { DemandForecastChart } from "@/components/pharmacy/charts";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { RunForecastButton } from "@/components/pharmacy/run-forecast-button";
import { DefinitionList, EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Analytics | Pharmacy | PharmaTwin" };

export default async function AnalyticsPage({ searchParams }) {
  const { product: requested } = await searchParams;
  const [overview, error] = await safe(pharmacyApi("/pharmacy/analytics"));
  if (error) {
    return (
      <>
        <PageHeader title="Analytics" mock={false} />
        <LoadError message={error} />
      </>
    );
  }
  const selectedId = requested ?? overview.products.find((p) => p.live.needsReorder)?.product.id ?? overview.products[0]?.product.id;
  const [detail, detailError] = selectedId ? await safe(pharmacyApi(`/pharmacy/analytics/products/${selectedId}`, { query: { days: 90 } })) : [null, null];

  return (
    <>
      <PharmacyRealtime tables={["reorder_recommendations", "sales"]} />
      <PageHeader title="Analytics" description="Demand forecast and recommended order quantity per product." mock={false}>
        <RunForecastButton label="Recalculate" />
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>Select a product to see its demand forecast.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {overview.products.length === 0 ? (
            <EmptyState title="No stock yet" className="mx-4">
              Analytics start once the pharmacy has received stock.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Product</TableHead>
                  <TableHead className="text-right">Current stock</TableHead>
                  <TableHead className="text-right">Forecasted demand / day</TableHead>
                  <TableHead>Stock cover</TableHead>
                  <TableHead className="pr-4 text-right">Recommended Q*</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.products.map((p) => (
                  <TableRow key={p.product.id} data-state={p.product.id === selectedId ? "selected" : undefined}>
                    <TableCell className="py-3 pl-4">
                      <Link href={`?product=${p.product.id}`} className="font-medium hover:underline" scroll={false}>
                        {productLabel(p.product)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNum(p.stock.available)} <span className="text-xs text-muted-foreground">{unitLabel(p.product)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(p.burnRate.rate, 1)}</TableCell>
                    <TableCell className="text-sm">{coverLabel(p.stockCover)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {p.live.recommendedPacks > 0 ? packsAndUnits(p.live.recommendedPacks, p.product) : "—"}
                      {p.live.needsReorder && (
                        <div>
                          <ToneBadge tone="red">Reorder now</ToneBadge>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {detailError && <LoadError message={detailError} />}
      {detail?.product && <ProductDetail detail={detail} />}
    </>
  );
}

function ProductDetail({ detail }) {
  const { product, unitLabel: units, stockCover, live, recommendation: rec } = detail;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{productLabel(product)}: demand forecast</CardTitle>
          <CardDescription>
            Daily {units} sold and the forecast for the next 14 days ({formatQty(live.dailyDemand, 1)} {units}/day).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DemandForecastChart history={detail.history} dailyDemand={live.dailyDemand} unitLabel={units} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recommended Q*</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <p className="text-2xl font-semibold tabular-nums">
            {live.recommendedPacks > 0 ? packsAndUnits(live.recommendedPacks, product) : "No order needed"}
          </p>
          {live.needsReorder ? <ToneBadge tone="red">Reorder now</ToneBadge> : <ToneBadge tone="green">Stock is sufficient</ToneBadge>}
          <DefinitionList
            items={[
              ["Forecast / day", `${formatQty(live.dailyDemand, 1)} ${units}`],
              ["Stock cover", coverLabel(stockCover)],
              ["Reorder point", `${formatNum(live.reorderPoint)} ${units}`],
              ["Projected stockout", formatDate(live.projectedStockoutDate)],
            ]}
          />
          {rec?.status === "pending" && (
            <p className="text-xs text-muted-foreground">
              <StatusBadge map={RECOMMENDATION_STATUS} value={rec.status} />{" "}
              <Link href="/dashboard/pharmacy/orders" className="font-medium underline-offset-4 hover:underline">
                Review on Orders →
              </Link>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
