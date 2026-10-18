import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { medicineLabel } from "@/lib/warehouse/format";
import { safe } from "@/lib/warehouse/page-data";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { MapPinIcon } from "@/components/icons/map-pin";
import { QrCodeIcon } from "@/components/icons/qr-code";
import { WarehouseIcon } from "@/components/icons/warehouse";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { LoadError } from "@/components/warehouse/load-error";
import { MovementsTable } from "@/components/warehouse/movements-table";
import { OccupancyBar } from "@/components/warehouse/occupancy-bar";
import { QrScanner } from "@/components/warehouse/qr-scanner";
import { ExpiryBadge, StorageBadge, ZoneTypeBadge } from "@/components/warehouse/warehouse-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse");
const ALERTS_SHOWN = 6;

export const metadata = {
  title: "Warehouse | PharmaTwin",
};

export default async function WarehouseOverviewPage() {
  const [[summary, summaryError], [alerts], [recent]] = await Promise.all([
    safe(warehouseApi("/warehouse/inventory/summary")),
    safe(warehouseApi("/warehouse/fefo/alerts")),
    safe(warehouseApi("/warehouse/movements", { query: { pageSize: 8 } })),
  ]);

  const hasSample = summary?.warehouses.some((warehouse) => warehouse.isSample);

  return (
    <>
      <PageHeader title="Warehouse" description={page.description} mock={false}>
        {hasSample && (
          <Badge variant="outline" title="Rows from supabase/seed/sample_warehouse.sql are marked SAMPLE">
            Includes sample data
          </Badge>
        )}
      </PageHeader>

      {summaryError ? (
        <LoadError message={summaryError} />
      ) : (
        <>
          <div className={styles.statGrid}>
            <StatCard
              label="Stock on hand"
              value={formatNumber(summary.totals.units)}
              hint={`units · ${summary.totals.medicines} medicines`}
              icon={WarehouseIcon}
            />
            <StatCard
              label="Batches in stock"
              value={formatNumber(summary.totals.batches)}
              hint={`${summary.totals.stockRecords} batch-location records`}
              icon={QrCodeIcon}
            />
            <StatCard
              label="Near expiry / critical"
              value={formatNumber(summary.expiry.near_expiry.batches + summary.expiry.critical.batches)}
              hint={`${summary.expiry.critical.batches} critical · ${formatNumber(
                summary.expiry.near_expiry.units + summary.expiry.critical.units
              )} units`}
              icon={CalendarDaysIcon}
            />
            <StatCard
              label="Expired batches"
              value={formatNumber(summary.expiry.expired.batches)}
              hint={`${formatNumber(summary.expiry.expired.units)} units to quarantine or dispose`}
              icon={BadgeAlertIcon}
            />
            <StatCard
              label="Free capacity"
              value={formatNumber(summary.capacity.availableUnits)}
              hint={`units · ${summary.capacity.utilizationPct ?? 0}% used · ${summary.capacity.fullLocations} full locations`}
              icon={MapPinIcon}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Pharmacy orders and stock flow</CardTitle>
              <CardDescription>
                <Link href="/dashboard/warehouse/orders" className={styles.link}>
                  Order queue →
                </Link>{" "}
                Warehouse stock includes packs reserved for orders until they are dispatched; in-transit and confirmed
                quantities come from the shipments the pharmacies receive (Component 4).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className={styles.statGrid}>
                {[
                  ["pending", "Pending", "awaiting stock reservation"],
                  ["processing", "Processing", "reserved, being picked"],
                  ["ready", "Ready to dispatch", "every pick verified"],
                  ["in_transit", "In transit", `${formatNumber(summary.flow.inTransitUnits)} packs on the road`],
                  ["received", "Received", `${formatNumber(summary.flow.confirmedUnits)} packs confirmed by pharmacies`],
                ].map(([stage, label, hint]) => (
                  <Link key={stage} href={`/dashboard/warehouse/orders?stage=${stage}`} className={styles.flowTile}>
                    <span className={`${styles.small} ${styles.muted}`}>{label}</span>
                    <span className={styles.score}>{formatNumber(summary.orders[stage])}</span>
                    <span className={`${styles.small} ${styles.muted}`}>{hint}</span>
                  </Link>
                ))}
              </div>
              <p className={`${styles.small} ${styles.muted}`}>
                Warehouse: {formatNumber(summary.flow.warehouseUnits)} packs on hand, {formatNumber(summary.flow.reservedUnits)}{" "}
                reserved · in transit: {formatNumber(summary.flow.inTransitUnits)} packs in {summary.flow.inTransitShipments}{" "}
                shipment(s) · confirmed at pharmacies: {formatNumber(summary.flow.confirmedUnits)} packs
                {summary.flow.notAcceptedUnits > 0 && ` (${formatNumber(summary.flow.notAcceptedUnits)} shipped packs not accepted)`}
              </p>
            </CardContent>
          </Card>

          {summary.quarantineRequired.batches > 0 && (
            <LoadError
              title="Stock needs to move to quarantine"
              message={`${summary.quarantineRequired.batches} batch(es) (${formatNumber(
                summary.quarantineRequired.units
              )} units) are expired, quarantined or recalled but still in storage zones. See FEFO.`}
            />
          )}

          <div className={`${styles.columns} ${styles.columnsWide}`}>
            <Card>
              <CardHeader>
                <CardTitle>FEFO alerts</CardTitle>
                <CardDescription>
                  Earliest expiry first.{" "}
                  <Link href="/dashboard/warehouse/fefo" className={styles.link}>
                    All alerts and FEFO picking →
                  </Link>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AlertsTable alerts={alerts?.alerts.slice(0, ALERTS_SHOWN) ?? []} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Capacity by zone</CardTitle>
                <CardDescription>Storage units used of the active locations.</CardDescription>
              </CardHeader>
              <CardContent className={styles.stack}>
                {summary.byZone.map((zone) => (
                  <div key={zone.zoneId} className={styles.field}>
                    <div className={styles.spread}>
                      <span className={styles.strong}>
                        {zone.zoneName} <span className={`${styles.muted} ${styles.small}`}>{zone.warehouseCode}</span>
                      </span>
                      <span className={styles.badgeRow}>
                        <ZoneTypeBadge zoneType={zone.zoneType} />
                        <StorageBadge condition={zone.storageCondition} isSecure={zone.isSecure} />
                      </span>
                    </div>
                    <OccupancyBar occupied={zone.occupiedUnits} capacity={zone.capacityUnits} label={`${zone.zoneName} capacity used`} />
                  </div>
                ))}
                {summary.byZone.length === 0 && <p className={styles.muted}>No storage locations yet.</p>}
              </CardContent>
            </Card>
          </div>

          <div className={`${styles.columns} ${styles.columnsWide}`}>
            <Card>
              <CardHeader>
                <CardTitle>Recent movements</CardTitle>
                <CardDescription>
                  <Link href="/dashboard/warehouse/movements" className={styles.link}>
                    Full movement history →
                  </Link>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MovementsTable movements={recent?.movements ?? []} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>QR lookup</CardTitle>
                <CardDescription>Scan a batch label to see where it is and move it.</CardDescription>
              </CardHeader>
              <CardContent>
                <QrScanner autoFocus={false} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

function AlertsTable({ alerts }) {
  if (alerts.length === 0) {
    return <p className={`${styles.muted} ${styles.textSm}`}>No batches are near expiry.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Batch</TableHead>
          <TableHead>Expiry</TableHead>
          <TableHead className={styles.right}>Units</TableHead>
          <TableHead>Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alerts.map((alert) => (
          <TableRow key={`${alert.warehouseId}:${alert.batchId}`}>
            <TableCell>
              <Link href={`/dashboard/warehouse/batches/${alert.batchId}`} className={`${styles.link} ${styles.mono}`}>
                {alert.batchNumber}
              </Link>
              <div className={`${styles.small} ${styles.muted}`}>{medicineLabel(alert)}</div>
            </TableCell>
            <TableCell>
              <ExpiryBadge expiry={alert.expiry} showDays />
              <div className={`${styles.small} ${styles.muted}`}>{formatDate(alert.expiryDate)}</div>
            </TableCell>
            <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(alert.quantity)}</TableCell>
            <TableCell className={`${styles.wrap} ${styles.small}`}>{alert.action}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
