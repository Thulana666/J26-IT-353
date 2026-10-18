import Link from "next/link";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { MOVEMENT_LABELS, formatDateTime } from "@/lib/warehouse/format";
import { cleanParams, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { SelectField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { MovementsTable } from "@/components/warehouse/movements-table";
import { ScanResultBadge } from "@/components/warehouse/warehouse-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/movements");
const BASE_PATH = "/dashboard/warehouse/movements";

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function MovementsPage({ searchParams }) {
  const params = await searchParams;
  const filters = cleanParams({ movementType: params.movementType, warehouseId: params.warehouseId });

  const [[result, error], [warehouses], [scans]] = await Promise.all([
    safe(warehouseApi("/warehouse/movements", { query: { ...filters, page: params.page, pageSize: 25 } })),
    safe(getWarehouses()),
    safe(warehouseApi("/warehouse/scans", { query: { limit: 20 } }).then((b) => b.scans)),
  ]);

  return (
    <>
      <PageHeader title="Movement history" description={page.description} mock={false} />

      <Card>
        <CardContent>
          <form method="get" className={styles.filterBar}>
            <SelectField
              id="movementType"
              label="Type"
              defaultValue={filters.movementType ?? ""}
              placeholder="All types"
              options={Object.entries(MOVEMENT_LABELS).map(([value, label]) => ({ value, label }))}
            />
            {warehouses?.length > 1 && (
              <SelectField
                id="warehouseId"
                label="Warehouse"
                defaultValue={filters.warehouseId ?? ""}
                placeholder="All warehouses"
                options={warehouses.map((w) => ({ value: w.id, label: w.code }))}
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
            <CardTitle>Movements</CardTitle>
            <CardDescription>
              {result.total} movement{result.total === 1 ? "" : "s"}, newest first. Stock only changes through these
              records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MovementsTable movements={result.movements} />
            <PagePagination page={result.page} pageCount={result.pageCount} basePath={BASE_PATH} params={filters} />
          </CardContent>
        </Card>
      )}

      {scans && (
        <Card>
          <CardHeader>
            <CardTitle>Recent QR scans</CardTitle>
            <CardDescription>Label lookups and pick verifications, including rejected codes.</CardDescription>
          </CardHeader>
          <CardContent>
            {scans.length === 0 ? (
              <p className={`${styles.muted} ${styles.textSm}`}>No scans yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Scanned</TableHead>
                    <TableHead>By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scans.map((scan) => (
                    <TableRow key={scan.id}>
                      <TableCell className={styles.num}>{formatDateTime(scan.createdAt)}</TableCell>
                      <TableCell className={styles.capitalize}>{scan.purpose.replace("_", " ")}</TableCell>
                      <TableCell>
                        <ScanResultBadge result={scan.result} />
                        {scan.message && <div className={`${styles.small} ${styles.muted} ${styles.wrap}`}>{scan.message}</div>}
                      </TableCell>
                      <TableCell className={`${styles.mono} ${styles.small}`}>
                        {scan.batchNumber ?? scan.scannedCode ?? "—"}
                        {scan.locationCode && ` @ ${scan.locationCode}`}
                      </TableCell>
                      <TableCell>{scan.userName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
