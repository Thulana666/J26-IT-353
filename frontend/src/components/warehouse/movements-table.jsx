import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { VIA_LABELS, formatDateTime, medicineLabel } from "@/lib/warehouse/format";
import { FefoBadge, MovementBadge } from "@/components/warehouse/warehouse-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import styles from "./warehouse.module.css";

// Movement history rows from GET /api/warehouse/movements (newest first).
export function MovementsTable({ movements, showBatch = true }) {
  if (movements.length === 0) {
    return <p className={`${styles.muted} ${styles.textSm}`}>No movements recorded yet.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Type</TableHead>
          {showBatch && <TableHead>Batch</TableHead>}
          <TableHead className={styles.right}>Qty</TableHead>
          <TableHead>From → To</TableHead>
          <TableHead>By</TableHead>
          <TableHead>Reference / notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {movements.map((movement) => (
          <TableRow key={movement.id}>
            <TableCell className={styles.num}>{formatDateTime(movement.createdAt)}</TableCell>
            <TableCell>
              <div className={styles.row}>
                <MovementBadge type={movement.movementType} />
                <FefoBadge compliant={movement.fefoCompliant} reason={movement.fefoOverrideReason} />
              </div>
            </TableCell>
            {showBatch && (
              <TableCell>
                <Link href={`/dashboard/warehouse/batches/${movement.batch.id}`} className={`${styles.link} ${styles.mono}`}>
                  {movement.batch.batchNumber ?? "Batch"}
                </Link>
                {movement.batch.medicineName && (
                  <div className={`${styles.small} ${styles.muted}`}>{medicineLabel(movement.batch)}</div>
                )}
              </TableCell>
            )}
            <TableCell className={`${styles.num} ${styles.right}`}>{formatNumber(movement.quantity)}</TableCell>
            <TableCell className={styles.mono}>
              {movement.from?.code ?? "—"} → {movement.to?.code ?? "—"}
            </TableCell>
            <TableCell>
              <div>{movement.performedBy?.name ?? (movement.performedVia === "system" ? "System" : "—")}</div>
              <div className={`${styles.small} ${styles.muted}`}>{VIA_LABELS[movement.performedVia]}</div>
            </TableCell>
            <TableCell className={styles.wrap}>
              {movement.reference && <div>{movement.reference}</div>}
              {movement.fefoOverrideReason && (
                <div className={styles.small}>Override: {movement.fefoOverrideReason}</div>
              )}
              {movement.notes && <div className={`${styles.small} ${styles.muted}`}>{movement.notes}</div>}
              {!movement.reference && !movement.notes && !movement.fefoOverrideReason && "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
