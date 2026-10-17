import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import {
  ALERT_TYPES,
  RISK,
  SEVERITY,
  formatDateTime,
  formatMoney,
  formatNum,
  packsAndUnits,
  productLabel,
} from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { ActivityIcon } from "@/components/icons/activity";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { ChartBarIncreasingIcon } from "@/components/icons/chart-bar-increasing";
import { PharmacyIcon } from "@/components/icons/pharmacy";
import { QrCodeIcon } from "@/components/icons/qr-code";
import { TrendingUpIcon } from "@/components/icons/trending-up";
import { WarehouseIcon } from "@/components/icons/warehouse";
import { StatusBadge, SyntheticBadge, ToneBadge } from "@/components/pharmacy/badges";
import { DailyRevenueChart } from "@/components/pharmacy/charts";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { RunForecastButton } from "@/components/pharmacy/run-forecast-button";
import { DataNote, EmptyState, LoadError, statGrid } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Pharmacy | PharmaTwin" };

export default async function PharmacyDashboardPage() {
  const [data, error] = await safe(pharmacyApi("/pharmacy/dashboard"));
  if (error) {
    return (
      <>
        <PageHeader title="Pharmacy" mock={false} />
        <LoadError message={error} />
      </>
    );
  }

  const { figures: f, pharmacy } = data;
  const syntheticDays = data.salesTrend.filter((d) => d.synthetic > 0).length;
  return (
    <>
      <PharmacyRealtime tables={["sales", "pharmacy_inventory", "shipments", "pharmacy_alerts"]} />
      <PageHeader title={pharmacy.name} description="Stock, sales, incoming shipments and rule-based reorder recommendations." mock={false}>
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/pharmacy/pos" />}>
          New sale
        </Button>
        <RunForecastButton label="Recalculate recommendations" />
      </PageHeader>

      {(data.latestRun?.dataNote || syntheticDays > 0) && (
        <DataNote>
          <strong>Synthetic demo data.</strong>{" "}
          {data.latestRun?.dataNote ??
            "Some sales in this period are generated sample history (sales.source = 'synthetic_seed'), not real transactions."}
        </DataNote>
      )}

      <div className={statGrid}>
        <StatCard label="Products in stock" value={formatNum(f.productsInStock)} hint={`of ${f.productsStocked} stocked products`} icon={PharmacyIcon} />
        <StatCard label="Stock value (cost)" value={formatMoney(f.stockValue)} hint="units on hand × unit cost" icon={ActivityIcon} />
        <StatCard label="Low / out of stock" value={`${f.lowStockItems} / ${f.outOfStockItems}`} hint="from active low-stock alerts" icon={BadgeAlertIcon} />
        <StatCard
          label="Near-expiry batches"
          value={formatNum(f.nearExpiryBatches)}
          hint={`${formatNum(f.nearExpiryUnits)} units · ${f.expiredBatches} expired batch(es)`}
          icon={CalendarDaysIcon}
        />
        <StatCard
          label="Pending receipts"
          value={formatNum(f.pendingShipments)}
          hint={`${f.heldItems} disputed item(s) held · ${f.heldUnits ?? 0} unit(s) on hold · ${f.openDiscrepancies} open report(s)`}
          icon={QrCodeIcon}
        />
        <StatCard label="Today's sales" value={formatMoney(f.todaySales.revenue)} hint={`${f.todaySales.bills} bill(s)`} icon={TrendingUpIcon} />
        <StatCard label="Reorder now" value={formatNum(f.reorderRecommendations)} hint="at or below their reorder point" icon={ChartBarIncreasingIcon} />
        <StatCard label="Open alerts" value={formatNum(f.openAlerts.total)} hint={`${f.openAlerts.critical} critical · ${f.pendingReturns} return(s) pending`} icon={WarehouseIcon} />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Revenue, last 14 days {syntheticDays > 0 && <SyntheticBadge>Includes synthetic days</SyntheticBadge>}
            </CardTitle>
            <CardDescription>Bills per day at this pharmacy (local time, Asia/Colombo).</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyRevenueChart data={data.salesTrend} currency={pharmacy.currency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
            <CardDescription>
              Most urgent first.{" "}
              <Link href="/dashboard/pharmacy/alerts" className="font-medium underline-offset-4 hover:underline">
                All alerts →
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {data.alerts.length === 0 && <EmptyState title="No active alerts" />}
            {data.alerts.map((alert) => (
              <div key={alert.id} className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{alert.title}</p>
                  <p className="text-xs text-muted-foreground">{alert.message}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge map={SEVERITY} value={alert.severity} />
                  <span className="text-xs text-muted-foreground">{ALERT_TYPES[alert.type]}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Reorder recommendations</CardTitle>
            <CardDescription>
              Products at or below their reorder point. Q* = target stock − inventory position.{" "}
              <Link href="/dashboard/pharmacy/orders" className="font-medium underline-offset-4 hover:underline">
                Review and order →
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.recommendations.length === 0 ? (
              <EmptyState title="Nothing to reorder right now">
                {data.latestRun ? "Every product is above its reorder point." : "Recalculate recommendations to compute Q*."}
              </EmptyState>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Days of cover</TableHead>
                    <TableHead>Stockout risk</TableHead>
                    <TableHead className="text-right">Recommended</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recommendations.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell>
                        <Link href={`/dashboard/pharmacy/analytics?product=${rec.medicineId}`} className="font-medium hover:underline">
                          {productLabel(rec.product)}
                        </Link>
                        {rec.isProvisional && <ToneBadge tone="amber" className="ml-2">Provisional</ToneBadge>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{rec.daysOfCover ?? "—"}</TableCell>
                      <TableCell>
                        <StatusBadge map={RISK} value={rec.stockoutRisk} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{packsAndUnits(rec.recommendedPacks, rec.product)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recommendations</CardTitle>
            <CardDescription>Moving-average estimates and Q* are recalculated from the latest sales and receipts.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {data.latestRun ? (
              <p>
                Last recalculated {formatDateTime(data.latestRun.finishedAt)}
                {data.latestRun.summary?.window_days ? ` · ${data.latestRun.summary.window_days}-day moving average` : ""}
                {data.latestRun.summary?.insufficient_history ? ` · ${data.latestRun.summary.insufficient_history} product(s) with insufficient history` : ""}
              </p>
            ) : (
              <EmptyState title="Not calculated yet">Recalculate recommendations to compute burn rates, stock cover and Q*.</EmptyState>
            )}
            <div>
              <p className="mb-1 font-medium">Recent sales</p>
              {data.recentSales.length === 0 && <p className="text-muted-foreground">No sales yet.</p>}
              <ul className="flex flex-col gap-1">
                {data.recentSales.map((sale) => (
                  <li key={sale.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{sale.saleNumber}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(sale.soldAt)}</span>
                    <span className="tabular-nums">{formatMoney(sale.totalAmount)}</span>
                    {sale.source === "synthetic_seed" && <SyntheticBadge>Synthetic</SyntheticBadge>}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
