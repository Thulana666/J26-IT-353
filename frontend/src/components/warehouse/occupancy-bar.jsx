import styles from "./warehouse.module.css";

export function utilizationLevel(percent) {
  if (percent >= 100) return "full";
  if (percent >= 85) return "high";
  return "normal";
}

// Capacity used, e.g. 64% of a zone or location.
export function OccupancyBar({ occupied, capacity, label = "Capacity used" }) {
  const percent = capacity > 0 ? Math.min(100, Math.round((occupied / capacity) * 100)) : 0;
  return (
    <div className={styles.meterRow} title={`${occupied} of ${capacity} units`}>
      <div
        className={styles.meter}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={styles.meterFill} data-level={utilizationLevel(percent)} style={{ width: `${percent}%` }} />
      </div>
      <span className={styles.meterValue}>{percent}%</span>
    </div>
  );
}
