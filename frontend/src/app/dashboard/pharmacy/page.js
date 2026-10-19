import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { safe } from "@/lib/pharmacy/page-data";
import { ALERT_TYPES, RISK, SEVERITY, formatMoney, formatNum, packsAndUnits, productLabel } from "@/lib/pharmacy/format";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { ChartBarIncreasingIcon } from "@/components/icons/chart-bar-increasing";
import { PharmacyIcon } from "@/components/icons/pharmacy";
import { TrendingUpIcon } from "@/components/icons/trending-up";
import { StatusBadge } from "@/components/pharmacy/badges";
import { DailyRevenueChart } from "@/components/pharmacy/charts";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { RunForecastButton } from "@/components/pharmacy/run-forecast-button";
import { EmptyState, LoadError, statGrid } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Pharmacy | PharmaTwin" };

// Alerts shown on the overview; the rest are on the Alerts page.
const TOP_ALERTS = 4;

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
  const revenue14 = data.salesTrend.reduce((t, d) => t + d.revenue, 0);

  // Stock health metrics for the empty-reorder-state panel.
  const totalStocked = f.productsStocked || 1;
  const inStock = f.productsInStock ?? 0;
  const lowStock = f.reorderRecommendations ?? 0;
  const healthyStock = Math.max(0, inStock - lowStock);
  // Fast Moving: proxy from today's sales bill count (capped at total).
  const fastMoving = Math.min(f.todaySales?.bills ?? 0, totalStocked);

  const healthPct = Math.round((healthyStock / totalStocked) * 100);
  const lowPct = Math.round((lowStock / totalStocked) * 100);
  const fastPct = Math.round((fastMoving / totalStocked) * 100);
  return (
    <>
      <PharmacyRealtime tables={["sales", "pharmacy_inventory", "shipments", "pharmacy_alerts"]} />
      <PageHeader title={pharmacy.name} description="Stock, sales and reorder needs at a glance." mock={false}>
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/pharmacy/pos" />}>
          New sale
        </Button>
        <RunForecastButton label="Recalculate" />
      </PageHeader>

      <div className={statGrid}>
        <StatCard label="Today's sales" value={formatMoney(f.todaySales.revenue)} hint={`${f.todaySales.bills} bill(s)`} icon={TrendingUpIcon} />
        <StatCard label="Products in stock" value={formatNum(f.productsInStock)} hint={`of ${f.productsStocked} stocked`} icon={PharmacyIcon} />
        <StatCard label="Reorder now" value={formatNum(f.reorderRecommendations)} hint="at or below reorder point" icon={ChartBarIncreasingIcon} />
        <StatCard label="Open alerts" value={formatNum(f.openAlerts.total)} hint={`${f.openAlerts.critical} critical`} icon={BadgeAlertIcon} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue, last 14 days</CardTitle>
          <CardDescription>{formatMoney(revenue14)} in total</CardDescription>
        </CardHeader>
        <CardContent>
          <DailyRevenueChart data={data.salesTrend} currency={pharmacy.currency} />
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top alerts</CardTitle>
            <CardDescription>
              <Link href="/dashboard/pharmacy/alerts" className="font-medium underline-offset-4 hover:underline">
                View all alerts →
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data.alerts.length === 0 && <EmptyState title="No active alerts" />}
            {data.alerts.slice(0, TOP_ALERTS).map((alert) => (
              <div key={alert.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{alert.title}</p>
                  <p className="text-xs text-muted-foreground">{ALERT_TYPES[alert.type]}</p>
                </div>
                <StatusBadge map={SEVERITY} value={alert.severity} className="shrink-0" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reorder now</CardTitle>
            <CardDescription>
              <Link href="/dashboard/pharmacy/orders" className="font-medium underline-offset-4 hover:underline">
                Review and order →
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {data.recommendations.length === 0 ? (
              <div className="mx-4 space-y-4 py-2">
                {/* Stock Health & Category Summary */}
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Stock Health &amp; Category Summary</p>
                <div className="space-y-3">
                  {/* Healthy Stock */}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span className="inline-block size-2 rounded-full bg-emerald-500" />
                        Healthy Stock
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{healthyStock} / {totalStocked}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-700"
                        style={{ width: `${healthPct}%` }}
                      />
                    </div>
                  </div>
                  {/* Low Stock */}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span className="inline-block size-2 rounded-full bg-amber-500" />
                        Low Stock
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{lowStock} / {totalStocked}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-400 transition-all duration-700"
                        style={{ width: `${lowPct}%` }}
                      />
                    </div>
                  </div>
                  {/* Fast Moving */}
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-medium">
                        <span className="inline-block size-2 rounded-full bg-violet-500" />
                        Fast Moving
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">{fastMoving} item{fastMoving !== 1 ? "s" : ""} sold today</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-purple-400 transition-all duration-700"
                        style={{ width: `${Math.min(fastPct, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">All products are within normal stock levels — no reorders needed right now.</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Product</TableHead>
                    <TableHead>Stockout risk</TableHead>
                    <TableHead className="pr-4 text-right">Recommended Q*</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.recommendations.map((rec) => (
                    <TableRow key={rec.id}>
                      <TableCell className="py-3 pl-4">
                        <Link href={`/dashboard/pharmacy/analytics?product=${rec.medicineId}`} className="font-medium hover:underline">
                          {productLabel(rec.product)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge map={RISK} value={rec.stockoutRisk} />
                      </TableCell>
                      <TableCell className="pr-4 text-right tabular-nums">{packsAndUnits(rec.recommendedPacks, rec.product)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
