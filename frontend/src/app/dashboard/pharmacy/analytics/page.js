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

const METHOD = { linear_regression: "Linear regression", moving_average: "Moving average" };
const fmt = (value, digits = 2) => (value === null || value === undefined ? "—" : formatQty(value, digits));

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

      <ModelCard model={overview.model} training={overview.run?.summary?.training} />

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
                    <TableCell className="text-right tabular-nums">
                      {formatQty(p.forecastDaily ?? p.burnRate.rate, 1)}
                      <div className="text-xs text-muted-foreground">{METHOD[p.method] ?? "Moving average"}</div>
                    </TableCell>
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
  const { product, unitLabel: units, stockCover, live, recommendation: rec, stock, modelEvaluation: evaluation } = detail;
  const method = METHOD[detail.method] ?? "Moving average";
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{productLabel(product)}: demand forecast</CardTitle>
          <CardDescription>
            Daily {units} sold and the {method.toLowerCase()} forecast for the next 14 days ({formatQty(live.dailyDemand, 1)} {units}/day on average).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DemandForecastChart
            history={detail.history}
            forecast={(detail.forecast ?? []).slice(0, 14)}
            unitLabel={units}
            forecastLabel={`Forecast (${method.toLowerCase()})`}
          />
          {evaluation && (
            <p className="text-xs text-muted-foreground">
              Held-out accuracy for this product ({evaluation.observations} days, {units}/day): linear regression MAE {fmt(evaluation.linearRegression.mae)} vs
              moving average MAE {fmt(evaluation.movingAverage.mae)}.{" "}
              {evaluation.selected ? "The regression was more accurate, so it is used." : "The moving average was as accurate or better, so it is used."}
              {detail.modelTrainedOn?.sample && " Evaluated on sample (synthetic) history."}
            </p>
          )}
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
          <div className="flex flex-wrap gap-1">
            {live.needsReorder ? <ToneBadge tone="red">Reorder now</ToneBadge> : <ToneBadge tone="green">No order needed</ToneBadge>}
            {stockCover.status === "out_of_stock" && <ToneBadge tone="red">Out of stock</ToneBadge>}
            {live.expiryRiskUnits > 0 && <ToneBadge tone="amber">Expiry risk</ToneBadge>}
          </div>
          {detail.reason && <p className="text-sm">{detail.reason}</p>}
          <DefinitionList
            items={[
              ["Forecast / day", `${formatQty(live.dailyDemand, 1)} ${units} (${method.toLowerCase()})`],
              ["Usable stock", `${formatNum(stock.onHandUsable)} ${units}`],
              ["Incoming (confirmed)", `${formatNum(stock.incoming)} ${units}`],
              ...(stock.awaiting > 0 ? [["Awaiting warehouse", `${formatNum(stock.awaiting)} ${units} (not counted)`]] : []),
              ...(stock.reserved > 0 ? [["Reserved (returns)", `${formatNum(stock.reserved)} ${units}`]] : []),
              ["Inventory position", `${formatNum(live.inventoryPosition)} ${units}`],
              ["Stock cover", coverLabel(stockCover)],
              ["Lead-time demand", `${formatNum(live.leadTimeDemand)} ${units}`],
              ["Safety stock", `${formatNum(live.safetyStock)} ${units}`],
              ["Reorder point", `${formatNum(live.reorderPoint)} ${units}`],
              ["Target stock", `${formatNum(live.targetStock)} ${units}`],
              ["Projected stockout", formatDate(live.projectedStockoutDate)],
              ...(live.expiryRiskUnits > 0 ? [["Expiry risk", `${formatNum(live.expiryRiskUnits)} ${units} may expire before they sell`]] : []),
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Rule-based replenishment: Q* = max(0, target stock − inventory position), in whole packs. Not a trained Q* model or EOQ.
          </p>
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

// The trained demand model and how it compared with the moving average.
function ModelCard({ model, training }) {
  if (!model) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Demand model</CardTitle>
          <CardDescription>
            Moving average in use. {training?.reason ?? "Press Recalculate to train the linear regression and compare it with the moving average."}
            {training?.migration_missing && " Apply migration 20261020000000_pharmacy_linear_regression_model.sql to use the trained model."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const lr = model.metrics.linearRegression;
  const ma = model.metrics.movingAverage;
  const better = lr.mae < ma.mae;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Demand model: linear regression
          {model.trainedOn.sample && <ToneBadge tone="violet">Trained on sample data</ToneBadge>}
        </CardTitle>
        <CardDescription>
          {model.trainedOn.sample
            ? `Trained and evaluated on sample (synthetic) history, ${formatDate(model.trainedOn.from)} – ${formatDate(model.trainedOn.to)}: a demonstration of the method, not real-world accuracy.`
            : `Trained on POS sales, ${formatDate(model.trainedOn.from)} – ${formatDate(model.trainedOn.to)}.`}{" "}
          Used for {model.productsUsingModel} of {model.products} products (where it beat the moving average); the rest use the moving average.{" "}
          {`Trained with ${model.trainedBy?.library ?? "scikit-learn"} in the Python AI service.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">
                Held out {formatDate(model.test.from)} – {formatDate(model.test.to)} ({formatNum(model.test.observations)} product-days)
              </TableHead>
              <TableHead className="text-right">MAE</TableHead>
              <TableHead className="pr-4 text-right">RMSE</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="pl-4">Linear regression {better && <ToneBadge tone="green">More accurate</ToneBadge>}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(lr.mae)}</TableCell>
              <TableCell className="pr-4 text-right tabular-nums">{fmt(lr.rmse)}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="pl-4">Moving average (baseline) {!better && <ToneBadge tone="green">More accurate</ToneBadge>}</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(ma.mae)}</TableCell>
              <TableCell className="pr-4 text-right tabular-nums">{fmt(ma.rmse)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <p className="px-4 pt-2 text-xs text-muted-foreground">
          Errors in {model.units}, one day ahead. Trained on {formatNum(model.train.observations)} earlier product-days; days that ended out of stock are
          excluded.
        </p>
      </CardContent>
    </Card>
  );
}
