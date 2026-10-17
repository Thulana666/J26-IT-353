import Link from "next/link";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { MOVEMENT_LABELS } from "@/lib/warehouse/format";
import { cleanParams, getWarehouses, safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { SelectField } from "@/components/warehouse/fields";
import { LoadError } from "@/components/warehouse/load-error";
import { MovementsTable } from "@/components/warehouse/movements-table";
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

  const [[result, error], [warehouses]] = await Promise.all([
    safe(warehouseApi("/warehouse/movements", { query: { ...filters, page: params.page, pageSize: 25 } })),
    safe(getWarehouses()),
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
    </>
  );
}
