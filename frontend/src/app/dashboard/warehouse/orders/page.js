import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { ORDER_STAGE_LABELS, formatDateTime } from "@/lib/warehouse/format";
import { safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { LoadError } from "@/components/warehouse/load-error";
import { OrderStageBadge, StatusBadge } from "@/components/warehouse/warehouse-badges";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/orders");
const BASE_PATH = "/dashboard/warehouse/orders";
// Work queue first.
const TABS = ["pending", "processing", "ready", "in_transit", "received", "cancelled"];

export const metadata = {
  title: "Warehouse orders | PharmaTwin",
};

export default async function OrdersPage({ searchParams }) {
  const { stage } = await searchParams;
  const active = TABS.includes(stage) ? stage : null;
  const [result, error] = await safe(warehouseApi("/warehouse/orders", { query: { stage: active ?? undefined } }));

  return (
    <>
      <PageHeader title="Pharmacy orders" description={page.description} mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : (
        <>
          <nav className={styles.row} aria-label="Order stages">
            <Link href={BASE_PATH} className={buttonVariants({ variant: active ? "outline" : "default", size: "sm" })}>
              All ({Object.values(result.counts).reduce((a, b) => a + b, 0)})
            </Link>
            {TABS.map((tab) => (
              <Link
                key={tab}
                href={`${BASE_PATH}?stage=${tab}`}
                className={buttonVariants({ variant: active === tab ? "default" : "outline", size: "sm" })}
                aria-current={active === tab ? "page" : undefined}
              >
                {ORDER_STAGE_LABELS[tab]} ({result.counts[tab]})
              </Link>
            ))}
          </nav>
          <Card>
            <CardHeader>
              <CardTitle>{active ? ORDER_STAGE_LABELS[active] : "All orders"}</CardTitle>
              <CardDescription>
                Orders submitted by pharmacies (Component 4). Pending orders need stock reserved; processing orders are
                being picked; ready orders can be dispatched.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {result.orders.length === 0 ? (
                <p className={`${styles.muted} ${styles.textSm}`}>No orders in this stage.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Pharmacy</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead className={styles.right}>Packs</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Shipment</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell>
                          <Link href={`${BASE_PATH}/${order.id}`} className={`${styles.link} ${styles.mono}`}>
                            {order.orderNumber}
                          </Link>
                          <div className={`${styles.small} ${styles.muted}`}>{order.itemCount} product(s)</div>
                        </TableCell>
                        <TableCell>{order.pharmacy?.name ?? "—"}</TableCell>
                        <TableCell className={styles.num}>{formatDateTime(order.submittedAt)}</TableCell>
                        <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(order.packsOrdered)}</TableCell>
                        <TableCell>
                          <OrderStageBadge stage={order.stage} />
                          {order.cancelReason && <div className={`${styles.small} ${styles.muted} ${styles.wrap}`}>{order.cancelReason}</div>}
                        </TableCell>
                        <TableCell>
                          {order.shipment ? (
                            <>
                              <span className={styles.mono}>{order.shipment.shipmentNumber}</span>{" "}
                              <StatusBadge status={order.shipment.status} />
                              {order.shipment.receivedAt && (
                                <div className={`${styles.small} ${styles.muted}`}>received {formatDate(order.shipment.receivedAt)}</div>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
