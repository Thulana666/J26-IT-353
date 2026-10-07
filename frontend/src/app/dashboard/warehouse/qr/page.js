import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { formatDate, formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { daysLabel, locationPath, medicineLabel } from "@/lib/warehouse/format";
import { getViewer, safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { BatchActions, getDestinations } from "@/components/warehouse/batch-actions";
import { LoadError } from "@/components/warehouse/load-error";
import { QrScanner } from "@/components/warehouse/qr-scanner";
import {
  BatchStatusBadge,
  ExpiryBadge,
  StorageBadge,
  ZoneTypeBadge,
} from "@/components/warehouse/warehouse-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/qr");

const ERROR_TITLES = {
  empty: "No code entered",
  format: "Not a valid PharmaTwin QR code",
  checksum: "Code was mis-scanned or mistyped",
  not_found: "Unknown QR code",
  inactive: "Deactivated label",
};

export const metadata = {
  title: `QR Scan | PharmaTwin`,
};

async function resolve(code) {
  try {
    return [await warehouseApi("/warehouse/qr/resolve", { method: "POST", body: { payload: code } }), null];
  } catch (error) {
    unstable_rethrow(error);
    return [null, { message: error.message, reason: error.details?.reason, batchId: error.details?.batchId }];
  }
}

export default async function QrPage({ searchParams }) {
  const { code } = await searchParams;
  const { isAdmin } = await getViewer();
  const [detail, scanError] = code ? await resolve(code) : [null, null];
  const [destinations] = detail ? await safe(getDestinations(detail)) : [[]];

  return (
    <>
      <PageHeader title="QR scan" description={page.description} mock={false} />

      <Card>
        <CardContent>
          <QrScanner key={code ?? ""} initialValue={code ?? ""} />
        </CardContent>
      </Card>

      {scanError && (
        <LoadError
          title={ERROR_TITLES[scanError.reason] ?? "QR code could not be looked up"}
          message={
            <>
              {scanError.message}{" "}
              {scanError.batchId && (
                <Link href={`/dashboard/warehouse/batches/${scanError.batchId}`}>Open the batch</Link>
              )}
            </>
          }
        />
      )}

      {detail && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className={styles.spread}>
                <span>
                  {medicineLabel(detail.batch.medicine)} ·{" "}
                  <Link href={`/dashboard/warehouse/batches/${detail.batch.id}`} className={`${styles.link} ${styles.mono}`}>
                    {detail.batch.batchNumber}
                  </Link>
                </span>
                <span className={styles.badgeRow}>
                  <BatchStatusBadge status={detail.batch.status} />
                  <ExpiryBadge expiry={detail.expiry} />
                </span>
              </CardTitle>
              <CardDescription>
                Scanned code <span className={styles.mono}>{detail.scannedCode}</span> · expires{" "}
                {formatDate(detail.batch.expiryDate)} ({daysLabel(detail.expiry.daysToExpiry)}) ·{" "}
                {formatNumber(detail.totalQuantity)} units in stock
              </CardDescription>
            </CardHeader>
            <CardContent className={styles.stack}>
              <StorageBadge
                condition={detail.batch.medicine.storageCondition}
                isControlled={detail.batch.medicine.isControlled}
              />
              {detail.stock.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Location</TableHead>
                      <TableHead>Zone</TableHead>
                      <TableHead className={styles.right}>Units</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.stock.map((item) => (
                      <TableRow key={item.stockId}>
                        <TableCell className={styles.mono}>{locationPath(item)}</TableCell>
                        <TableCell>
                          <ZoneTypeBadge zoneType={item.zoneType} />
                          {item.zoneType === "storage" && <span className={styles.muted}>Storage</span>}
                        </TableCell>
                        <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(item.quantity)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {detail.requiresQuarantine && (
                <p className={styles.formError}>
                  This batch must be moved to a quarantine zone (it is {detail.batch.status === "active" ? "expired" : detail.batch.status}).
                </p>
              )}
            </CardContent>
          </Card>

          {detail.batch.status !== "disposed" && (
            <BatchActions detail={detail} destinations={destinations ?? []} isAdmin={isAdmin} via="qr_scan" />
          )}
        </>
      )}
    </>
  );
}
