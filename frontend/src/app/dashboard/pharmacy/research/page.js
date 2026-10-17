import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { formatDate, formatDateTime, formatMoney, formatNum, formatPct, formatQty } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { ActivityIcon } from "@/components/icons/activity";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { ChartBarIncreasingIcon } from "@/components/icons/chart-bar-increasing";
import { CircleCheckIcon } from "@/components/icons/circle-check";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { TrendingUpIcon } from "@/components/icons/trending-up";
import { WarehouseIcon } from "@/components/icons/warehouse";
import { SyntheticBadge, ToneBadge } from "@/components/pharmacy/badges";
import { EstimateErrorChart, StockTrendChart, WeeklySalesChart } from "@/components/pharmacy/charts";
import { DataNote, EmptyState, LoadError, statGrid } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Research | Pharmacy | PharmaTwin" };

const WINDOWS = [30, 90, 180];

export default async function ResearchPage({ searchParams }) {
  const { days: raw = "90" } = await searchParams;
  const days = WINDOWS.includes(Number(raw)) ? Number(raw) : 90;
  const [m, error] = await safe(pharmacyApi("/pharmacy/analytics/research", { query: { days } }));

  return (
    <>
      <PageHeader title="Research evaluation" description="Metrics computed from this pharmacy's recorded data: sales, stock ledger, moving-average estimates, recommendations and returns." mock={false}>
        {WINDOWS.map((d) => (
          <Button key={d} size="sm" variant={d === days ? "default" : "outline"} nativeButton={false} render={<Link href={`?days=${d}`} />}>
            {d} days
          </Button>
        ))}
      </PageHeader>
      {error ? (
        <LoadError message={error} />
      ) : (
        <ResearchBody m={m} />
      )}
    </>
  );
}

function ResearchBody({ m }) {
  const p = m.provenance;
  const h = m.estimateAccuracy;
  const synthetic = p.syntheticShare > 0;
  return (
    <>
      {synthetic ? (
        <DataNote>
          <strong>Demonstration only — not experimental findings.</strong> {formatPct(p.syntheticShare, 0)} of the units sold between {formatDate(p.from)} and{" "}
          {formatDate(p.to)} are synthetic seed data (sales.source = &apos;synthetic_seed&apos;); {formatNum(p.posUnits)} units come from real POS sales. Report
          results only from periods with real transactions.
        </DataNote>
      ) : (
        <DataNote tone="blue">
          All {formatNum(p.posUnits)} units sold between {formatDate(p.from)} and {formatDate(p.to)} were recorded through the POS (no synthetic data).
        </DataNote>
      )}

      <div className={statGrid}>
        <StatCard
          label="Estimate error (MAE)"
          value={h?.meanMae !== null && h?.meanMae !== undefined ? formatQty(h.meanMae, 2) : "—"}
          hint={h ? `units/day, mean over ${h.products.length} product(s) · actual vs moving average` : "recalculate recommendations first"}
          icon={TrendingUpIcon}
        />
        <StatCard label="Stockout rate" value={formatPct(m.stockout.rate, 1)} hint={`${formatNum(m.stockout.stockoutDays)} of ${formatNum(m.stockout.productDays)} product-days`} icon={BadgeAlertIcon} />
        <StatCard
          label="Near-expiry + expired"
          value={formatNum(m.expiry.nearExpiry.units + m.expiry.critical.units + m.expiry.expired.units)}
          hint={`units now · ${formatMoney(m.expiry.nearExpiry.value + m.expiry.critical.value + m.expiry.expired.value)} at cost`}
          icon={CalendarDaysIcon}
        />
        <StatCard label="Inventory turnover" value={m.turnover.annualisedTurnover ?? "—"} hint={`per year · ${m.turnover.daysOfInventory ?? "—"} days of inventory`} icon={RefreshCWIcon} />
        <StatCard
          label="Recommendation acceptance"
          value={formatPct(m.acceptance.acceptanceRate, 0)}
          hint={`${m.acceptance.accepted} accepted · ${m.acceptance.edited} edited · ${m.acceptance.rejected} rejected`}
          icon={CircleCheckIcon}
        />
        <StatCard label="Excess stock" value={formatNum(m.excess.units)} hint={`units above target in ${m.excess.products} product(s) · ${formatMoney(m.excess.value)}`} icon={WarehouseIcon} />
        <StatCard label="Expired units returned" value={formatNum(m.expiry.expiredReturnedUnits)} hint={`+ ${formatNum(m.expiry.nearExpiryReturnedUnits)} near-expiry, in the window`} icon={ActivityIcon} />
        <StatCard label="Cost of goods sold" value={formatMoney(m.turnover.cogs)} hint={`avg stock value ${formatMoney(m.turnover.averageInventoryValue)}`} icon={ChartBarIncreasingIcon} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Actual vs estimated demand {synthetic && <SyntheticBadge />}
          </CardTitle>
          <CardDescription>
            {h
              ? `From the run of ${formatDateTime(h.runAt)}: for each of the last ${h.testDays} days, the ${h.windowDays ?? ""}-day moving average of the days before it compared with the units actually sold. Measured on recorded sales; lower is better.`
              : "No moving-average run yet. Recalculate recommendations on the Analytics page."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!h || h.products.length === 0 ? (
            <EmptyState title="Not enough history yet">
              A product needs its full window of sales history before the days that are compared.
            </EmptyState>
          ) : (
            <>
              <EstimateErrorChart rows={h.products} />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Days compared</TableHead>
                    <TableHead className="text-right">MAE (units/day)</TableHead>
                    <TableHead className="text-right">RMSE</TableHead>
                    <TableHead className="text-right">Bias</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {h.products.map((p) => (
                    <TableRow key={p.medicineId}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.days}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(p.mae, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(p.rmse, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(p.bias, 2)} <span className="text-xs text-muted-foreground">{p.bias > 0 ? "under-estimated" : p.bias < 0 ? "over-estimated" : ""}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {h.insufficient > 0 && <p className="text-xs text-muted-foreground">{h.insufficient} product(s) had too little history to compare.</p>}
            </>
          )}
          {m.liveAccuracy.moving_average && (
            <p className="text-sm text-muted-foreground">
              Stored estimates compared with what was later sold: MAE {formatQty(m.liveAccuracy.moving_average.mae, 2)} over{" "}
              {m.liveAccuracy.moving_average.points} product-days.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Units sold per week</CardTitle>
            <CardDescription>Split by data source, so synthetic history is never mistaken for real sales.</CardDescription>
          </CardHeader>
          <CardContent>{m.trends.weeklySales.length ? <WeeklySalesChart data={m.trends.weeklySales} /> : <EmptyState title="No sales in the window" />}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Stock on hand (all products)</CardTitle>
            <CardDescription>Closing units per day from the stock ledger: depletion and restocking cycles.</CardDescription>
          </CardHeader>
          <CardContent>{m.trends.dailyStock.length ? <StockTrendChart data={m.trends.dailyStock} /> : <EmptyState title="No stock history" />}</CardContent>
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Stockouts by product</CardTitle>
            <CardDescription>Share of days that ended with no stock (demand on those days is censored).</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Product</TableHead>
                  <TableHead className="text-right">Stockout days</TableHead>
                  <TableHead className="pr-4 text-right">Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {m.stockout.byProduct.map((s) => (
                  <TableRow key={s.medicineId}>
                    <TableCell className="pl-4">{s.name}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.stockoutDays} / {s.days}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{formatPct(s.rate, 1)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Excess stock and expiry exposure</CardTitle>
            <CardDescription>Excess = available units above the current target stock S.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-3 gap-2">
              {[
                ["Expired", m.expiry.expired],
                ["≤ 30 days", m.expiry.critical],
                ["Near expiry", m.expiry.nearExpiry],
              ].map(([label, bucket]) => (
                <div key={label} className="rounded-lg border p-2">
                  <p className="text-muted-foreground">{label}</p>
                  <p className="tabular-nums">
                    <strong>{formatNum(bucket.units)}</strong> units
                  </p>
                  <p className="text-xs text-muted-foreground">{formatMoney(bucket.value)}</p>
                </div>
              ))}
            </div>
            {m.excess.items.length === 0 ? (
              <p className="text-muted-foreground">No product is above its target stock.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {m.excess.items.map((e) => (
                  <li key={e.medicineId} className="flex justify-between gap-2">
                    <span>
                      {e.name} {e.flagged && <ToneBadge tone="amber">Excess</ToneBadge>}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      +{formatNum(e.excessUnits)} units · {e.daysOfCover ?? "—"} days cover
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Recommendations generated in the window: {m.acceptance.generated} ({m.acceptance.pending} pending, {m.acceptance.superseded} superseded by newer runs).
              {m.acceptance.meanEditPacks !== null && ` Edited orders changed Q* by ${m.acceptance.meanEditPacks} pack(s) on average.`}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
