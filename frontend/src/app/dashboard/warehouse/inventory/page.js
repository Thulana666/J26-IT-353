import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { EXPIRY_LABELS, locationPath, medicineLabel } from "@/lib/warehouse/format";
import { cleanParams, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { SelectField, TextField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import {
  BatchStatusBadge,
  ExpiryBadge,
  StorageBadge,
  ZoneTypeBadge,
} from "@/components/warehouse/warehouse-badges";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/inventory");
const BASE_PATH = "/dashboard/warehouse/inventory";

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function InventoryPage({ searchParams }) {
  const params = await searchParams;
  const filters = cleanParams({
    q: params.q,
    expiryStatus: params.expiryStatus,
    zoneType: params.zoneType,
    warehouseId: params.warehouseId,
  });

  const [[result, error], [warehouses]] = await Promise.all([
    safe(warehouseApi("/warehouse/inventory", { query: { ...filters, page: params.page, pageSize: 50 } })),
    safe(getWarehouses()),
  ]);

  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false}>
        <Link href="/dashboard/warehouse/allocation" className={buttonVariants({ variant: "default" })}>
          Receive stock
        </Link>
      </PageHeader>

      <Card>
        <CardContent>
          <form method="get" className={styles.filterBar}>
            <TextField id="q" label="Search" defaultValue={filters.q} placeholder="Medicine, batch or location" />
            <SelectField
              id="expiryStatus"
              label="Expiry"
              defaultValue={filters.expiryStatus ?? ""}
              placeholder="All"
              options={Object.entries(EXPIRY_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <SelectField
              id="zoneType"
              label="Zone"
              defaultValue={filters.zoneType ?? ""}
              placeholder="All zones"
              options={[
                { value: "storage", label: "Storage" },
                { value: "quarantine", label: "Quarantine" },
              ]}
            />
            {warehouses?.length > 1 && (
              <SelectField
                id="warehouseId"
                label="Warehouse"
                defaultValue={filters.warehouseId ?? ""}
                placeholder="All warehouses"
                options={warehouses.map((w) => ({ value: w.id, label: `${w.code} – ${w.name}` }))}
              />
            )}
            <div className={styles.actions}>
              <Link href={BASE_PATH} className={buttonVariants({ variant: "ghost" })}>
                Clear
              </Link>
              <Button type="submit" variant="outline">
                Apply
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <LoadError message={error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Stock by batch and location</CardTitle>
            <CardDescription>
              {result.total === 0
                ? "No stock matches."
                : `${result.total} record${result.total === 1 ? "" : "s"}, ${formatNumber(result.totalUnits)} units. Earliest expiry first (FEFO order).`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {result.items.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medicine</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className={styles.right}>Units</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((item) => (
                    <TableRow key={item.stockId}>
                      <TableCell>
                        <div className={styles.strong}>{medicineLabel(item)}</div>
                        <StorageBadge condition={item.storageCondition} isControlled={item.isControlled} />
                      </TableCell>
                      <TableCell>
                        <Link href={`/dashboard/warehouse/batches/${item.batchId}`} className={`${styles.link} ${styles.mono}`}>
                          {item.batchNumber}
                        </Link>
                        {item.batchStatus !== "active" && (
                          <div>
                            <BatchStatusBadge status={item.batchStatus} />
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ExpiryBadge expiry={item.expiry} showDays />
                        <div className={`${styles.small} ${styles.muted}`}>{formatDate(item.expiryDate)}</div>
                      </TableCell>
                      <TableCell>
                        <div className={styles.mono}>{locationPath(item)}</div>
                        <ZoneTypeBadge zoneType={item.zoneType} />
                      </TableCell>
                      <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(item.quantity)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <PagePagination page={result.page} pageCount={result.pageCount} basePath={BASE_PATH} params={filters} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
