import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import {
  BURN_STATUS,
  RECOMMENDATION_STATUS,
  SAFETY_METHODS,
  coverLabel,
  formatDate,
  formatDateTime,
  formatNum,
  formatQty,
  packsAndUnits,
  productLabel,
} from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge, SyntheticBadge, ToneBadge } from "@/components/pharmacy/badges";
import { ActualVsEstimatedChart, Sparkline, StockLevelChart } from "@/components/pharmacy/charts";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { RunForecastButton } from "@/components/pharmacy/run-forecast-button";
import { DataNote, DefinitionList, EmptyState, LoadError } from "@/components/pharmacy/ui";
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
  const run = overview.run;
  const w = overview.windowDays;

  return (
    <>
      <PharmacyRealtime tables={["reorder_recommendations", "sales"]} />
      <PageHeader
        title="Analytics"
        description={`Burn rate, stock cover and a ${w}-day moving-average demand estimate per product, with the rule-based reorder quantity Q*.`}
        mock={false}
      >
        <RunForecastButton label="Recalculate recommendations" />
      </PageHeader>

      <DataNote tone="blue">
        Average daily consumption = units sold in the last {w} days ÷ {w} (sales only; returns and stock corrections are not counted). Days of stock
        cover = usable available stock ÷ average daily consumption. The moving average is used as the demand estimate; no model is trained.
        {run && (
          <>
            {" "}
            Recommendations last recalculated {formatDateTime(run.finishedAt ?? run.startedAt)}.
          </>
        )}
        {run?.dataNote && (
          <>
            {" "}
            <strong>{run.dataNote}</strong>
          </>
        )}
      </DataNote>

      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>Live from current stock and sales. Select a product for its sales history and the Q* calculation.</CardDescription>
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
                  <TableHead>Last 30 days</TableHead>
                  <TableHead className="text-right">Burn rate / day</TableHead>
                  <TableHead className="text-right">Usable available</TableHead>
                  <TableHead className="text-right">Incoming</TableHead>
                  <TableHead>Stock cover</TableHead>
                  <TableHead className="text-right">Position / reorder point</TableHead>
                  <TableHead className="pr-4 text-right">Q*</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.products.map((p) => (
                  <TableRow key={p.product.id} data-state={p.product.id === selectedId ? "selected" : undefined}>
                    <TableCell className="pl-4">
                      <Link href={`?product=${p.product.id}`} className="font-medium hover:underline" scroll={false}>
                        {productLabel(p.product)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Sparkline values={p.last30} label={`${productLabel(p.product)}, last 30 days`} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(p.burnRate.rate, 2)}
                      <div className="text-xs text-muted-foreground">
                        {formatNum(p.burnRate.totalSold)} sold in {p.burnRate.daysUsed} d
                      </div>
                      {p.burnRate.status !== "ok" && <StatusBadge map={BURN_STATUS} value={p.burnRate.status} />}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatNum(p.stock.available)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.stock.incoming ? formatNum(p.stock.incoming) : "—"}</TableCell>
                    <TableCell className="text-sm">{coverLabel(p.stockCover)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNum(p.live.inventoryPosition)} / {formatNum(p.live.reorderPoint)}
                      {p.live.needsReorder && (
                        <div>
                          <ToneBadge tone="red">Reorder now</ToneBadge>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {p.live.recommendedPacks > 0 ? packsAndUnits(p.live.recommendedPacks, p.product) : "0"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {detailError && <LoadError message={detailError} />}
      {detail?.product && <ProductDetail detail={detail} synthetic={Boolean(run?.dataNote)} />}
    </>
  );
}

function ProductDetail({ detail, synthetic }) {
  const { product, unitLabel: units, burnRate, stockCover, live, backtest, recommendation: rec, settings, windowDays: w } = detail;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {productLabel(product)}: actual vs estimated demand
            {synthetic && <SyntheticBadge>History includes synthetic data</SyntheticBadge>}
          </CardTitle>
          <CardDescription>
            Daily {units} sold over 90 days, and for each day the {w}-day moving average of the days before it (the estimate that would have been used
            that day). Grey dots: days that ended out of stock.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {backtest.sufficient ? (
            <p className="text-sm">
              Over {backtest.days} days the estimate was off by <strong>{formatQty(backtest.mae, 2)}</strong> {units}/day on average (MAE; RMSE{" "}
              {formatQty(backtest.rmse, 2)}). {backtest.bias > 0 ? "Demand was mostly above" : "Demand was mostly below"} the estimate (bias{" "}
              {formatQty(backtest.bias, 2)}). Last 28 days: MAE {formatQty(backtest.recentMae, 2)}.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not enough history for an actual-versus-estimated comparison yet (needs {w} days before the compared days).
            </p>
          )}
          <ActualVsEstimatedChart history={detail.history} points={backtest.points} unitLabel={units} windowDays={w} />
          <div>
            <p className="mb-1 text-sm font-medium">Closing stock</p>
            <StockLevelChart history={detail.history} reorderPoint={live.reorderPoint} unitLabel={units} />
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Show data table</summary>
            <div className="mt-2 max-h-72 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Sold</TableHead>
                    <TableHead className="text-right">Estimate</TableHead>
                    <TableHead className="text-right">Closing stock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.history.slice(-45).map((d) => {
                    const point = backtest.points.find((p) => p.date === d.date);
                    return (
                      <TableRow key={d.date}>
                        <TableCell>{formatDate(d.date)}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.sold}</TableCell>
                        <TableCell className="text-right tabular-nums">{point ? formatQty(point.estimate) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.closingOnHand ?? "—"}
                          {d.closingOnHand === 0 ? " (out)" : ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recommended Q*</CardTitle>
          <CardDescription>Rule-based order-up-to quantity, not the classical EOQ formula. Live from current stock.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-2xl font-semibold tabular-nums">
            {live.recommendedPacks > 0 ? packsAndUnits(live.recommendedPacks, product) : "No order needed"}
          </p>
          {live.needsReorder ? (
            <ToneBadge tone="red">Position at or below the reorder point: reorder now</ToneBadge>
          ) : (
            <ToneBadge tone="gray">Above the reorder point: can wait for the next review</ToneBadge>
          )}
          <DefinitionList
            items={[
              [
                "Average daily consumption",
                <span key="b">
                  {formatNum(burnRate.totalSold)} sold ÷ {burnRate.daysUsed} days = <strong>{formatQty(burnRate.rate, 2)}</strong> {units}/day{" "}
                  {burnRate.status !== "ok" && <StatusBadge map={BURN_STATUS} value={burnRate.status} />}
                </span>,
              ],
              ["Stockout days in window", `${burnRate.stockoutDays} (counted in the average)`],
              ["Days of stock cover", coverLabel(stockCover)],
              ["Lead time / review period", `${settings.leadTimeDays} / ${settings.reviewPeriodDays} days`],
              ["Demand during lead time", `${formatQty(live.dailyDemand, 2)} × ${settings.leadTimeDays} = ${formatNum(live.leadTimeDemand)}`],
              ["Demand during review period", `${formatQty(live.dailyDemand, 2)} × ${settings.reviewPeriodDays} = ${formatNum(live.reviewPeriodDemand)}`],
              ["Safety stock", `${formatNum(live.safetyStock)} (${SAFETY_METHODS[settings.safety.method]}: ${live.safetyDescription})`],
              ["Reorder point", `${formatNum(live.leadTimeDemand)} + ${formatNum(live.safetyStock)} = ${formatNum(live.reorderPoint)}`],
              ["Target stock level", `${formatNum(live.leadTimeDemand)} + ${formatNum(live.reviewPeriodDemand)} + ${formatNum(live.safetyStock)} = ${formatNum(live.targetStock)}`],
              [
                "Inventory position",
                `${formatNum(detail.stock.onHandUsable)} usable + ${formatNum(detail.stock.incoming)} incoming − ${formatNum(detail.stock.reserved)} reserved = ${formatNum(live.inventoryPosition)}`,
              ],
              ["Q* (before packs)", `max(0, ${formatNum(live.targetStock)} − ${formatNum(live.inventoryPosition)}) = ${formatNum(live.rawQuantity)} ${units}`],
              ["Projected stockout", formatDate(live.projectedStockoutDate)],
              ["Expiry risk", `${formatNum(live.expiryRiskUnits)} ${units} may expire before they sell (FEFO)`],
            ]}
          />
          {live.constraints.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {live.constraints.map((c) => (
                <li key={c.type}>{c.detail}</li>
              ))}
            </ul>
          )}
          {rec && (
            <p className="text-xs text-muted-foreground">
              Saved recommendation ({formatDateTime(rec.generatedAt)}): {rec.recommendedPacks} pack(s) · <StatusBadge map={RECOMMENDATION_STATUS} value={rec.status} />
              {rec.status === "pending" && (
                <>
                  {" · "}
                  <Link href="/dashboard/pharmacy/orders" className="font-medium underline-offset-4 hover:underline">
                    accept, edit or reject on Orders
                  </Link>
                </>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Usable stock excludes expired, recalled and quarantined batches; disputed shipment items are never in stock. Incoming = shipments in transit +
            submitted orders not yet dispatched.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
