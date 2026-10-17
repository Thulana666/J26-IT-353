import { AnimatedIcon } from "@/components/icons/animated-icon";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import styles from "./warehouse.module.css";

// Shown when a warehouse page cannot load its data from the backend.
export function LoadError({ title = "Warehouse data could not be loaded", message }) {
  return (
    <Alert variant="destructive">
      <AnimatedIcon icon={BadgeAlertIcon} className={styles.alertIcon} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
