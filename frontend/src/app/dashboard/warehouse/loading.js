import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "@/components/warehouse/warehouse.module.css";

const ROWS = 6;

// Shown by Next.js while a warehouse page loads its data from the backend.
export default function WarehouseLoading() {
  return (
    <Card aria-busy="true" aria-label="Loading warehouse data">
      <CardHeader className={styles.stack}>
        <Skeleton style={{ height: "1.25rem", width: "12rem" }} />
        <Skeleton style={{ height: "1rem", width: "18rem" }} />
      </CardHeader>
      <CardContent className={styles.stack}>
        {Array.from({ length: ROWS }, (_, index) => (
          <Skeleton key={index} style={{ height: "1rem", width: "100%" }} />
        ))}
      </CardContent>
    </Card>
  );
}
