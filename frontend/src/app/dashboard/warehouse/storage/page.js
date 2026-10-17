import Link from "next/link";
import { formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { warehouseApi } from "@/lib/warehouse/api";
import { EXPIRY_LABELS } from "@/lib/warehouse/format";
import { safe } from "@/lib/warehouse/page-data";
import { PageHeader } from "@/components/dashboard/page-header";
import { LoadError } from "@/components/warehouse/load-error";
import { OccupancyBar, utilizationLevel } from "@/components/warehouse/occupancy-bar";
import { StorageBadge, ZoneTypeBadge } from "@/components/warehouse/warehouse-badges";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import styles from "@/components/warehouse/warehouse.module.css";

const page = getNavItem("/dashboard/warehouse/storage");

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function StoragePage() {
  const [result, error] = await safe(warehouseApi("/warehouse/storage"));

  return (
    <>
      <PageHeader title="Storage locations" description={page.description} mock={false} />
      {error ? (
        <LoadError message={error} />
      ) : result.warehouses.length === 0 ? (
        <Card>
          <CardContent>
            <p className={styles.muted}>
              No warehouses yet. Load supabase/seed/sample_warehouse.sql or add one through the API.
            </p>
          </CardContent>
        </Card>
      ) : (
        result.warehouses.map((warehouse) => <WarehouseCard key={warehouse.id} warehouse={warehouse} />)
      )}
    </>
  );
}

function WarehouseCard({ warehouse }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {warehouse.name} <span className={`${styles.mono} ${styles.muted} ${styles.small}`}>{warehouse.code}</span>
        </CardTitle>
        <CardDescription>
          {[warehouse.location?.name, warehouse.address].filter(Boolean).join(" · ") || "No location set"} ·{" "}
          {warehouse.totals.locations} locations · {formatNumber(warehouse.totals.occupiedUnits)} of{" "}
          {formatNumber(warehouse.totals.capacityUnits)} units used
        </CardDescription>
      </CardHeader>
      <CardContent className={styles.stack}>
        <OccupancyBar
          occupied={warehouse.totals.occupiedUnits}
          capacity={warehouse.totals.capacityUnits}
          label={`${warehouse.code} capacity used`}
        />
        <div className={styles.legend}>
          <span>
            <span className={`${styles.swatch} ${styles.toneGreen}`} />
            Fill shows capacity used
          </span>
          <span>
            <span className={`${styles.swatch} ${styles.toneAmber}`} />
            85% or more
          </span>
          <span>
            <span className={`${styles.swatch} ${styles.toneRed}`} />
            Full / needs attention (red border)
          </span>
          <span>Dashed: inactive. Shelves are drawn top level first; select a location to see its stock.</span>
        </div>
        {warehouse.zones.map((zone) => (
          <section key={zone.id} className={styles.stack} aria-label={zone.name}>
            <div className={styles.spread}>
              <div>
                <span className={styles.strong}>
                  {zone.code} · {zone.name}
                </span>
                <span className={`${styles.muted} ${styles.small}`}>
                  {zone.minTempC !== null && zone.maxTempC !== null && ` · ${zone.minTempC}–${zone.maxTempC} °C`}
                  {` · ${formatNumber(zone.totals.occupiedUnits)}/${formatNumber(zone.totals.capacityUnits)} units`}
                </span>
              </div>
              <span className={styles.badgeRow}>
                <ZoneTypeBadge zoneType={zone.zoneType} />
                <StorageBadge condition={zone.storageCondition} isSecure={zone.isSecure} />
              </span>
            </div>
            <div className={styles.rackGrid}>
              {zone.racks.map((rack) => (
                <Rack key={rack.id} rack={rack} zoneType={zone.zoneType} />
              ))}
              {zone.racks.length === 0 && <p className={styles.muted}>No racks in this zone.</p>}
            </div>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function Rack({ rack, zoneType }) {
  const byLevel = new Map();
  for (const location of rack.locations) {
    if (!byLevel.has(location.level)) byLevel.set(location.level, []);
    byLevel.get(location.level).push(location);
  }
  const levels = [...byLevel.entries()].sort(([a], [b]) => b - a);
  const positions = Math.max(1, ...levels.map(([, list]) => list.length));

  return (
    <div className={styles.rack}>
      <div className={styles.spread}>
        <span className={`${styles.mono} ${styles.strong}`}>{rack.code}</span>
        <span className={`${styles.small} ${styles.muted}`}>{rack.distanceToDispatchM} m to dispatch</span>
      </div>
      {levels.map(([level, locations]) => (
        <div key={level} className={styles.shelf} style={{ "--positions": positions }}>
          <span className={styles.shelfLabel}>L{level}</span>
          {locations.map((location) => (
            <LocationCell key={location.id} location={location} zoneType={zoneType} />
          ))}
        </div>
      ))}
    </div>
  );
}

function LocationCell({ location, zoneType }) {
  const percent = location.capacityUnits ? Math.round((location.occupiedUnits / location.capacityUnits) * 100) : 0;
  // Blocked or expired stock still in a storage zone needs attention.
  const needsAttention =
    zoneType === "storage" &&
    location.stock.some((item) => item.batchStatus !== "active" || item.expiry.status === "expired");
  const contents = location.stock.map(
    (item) =>
      `${item.medicineName} ${item.strength ?? ""} · ${item.batchNumber} · ${item.quantity} units · ${EXPIRY_LABELS[item.expiry.status]}`
  );
  const title = [
    `${location.code}: ${location.occupiedUnits}/${location.capacityUnits} units, ${location.accessibility} accessibility`,
    ...contents,
  ].join("\n");

  return (
    <Link
      href={`/dashboard/warehouse/inventory?q=${encodeURIComponent(location.code)}`}
      className={styles.cell}
      data-level={utilizationLevel(percent)}
      data-inactive={!location.isActive}
      data-alert={needsAttention}
      style={{ "--fill": `${percent}%` }}
      title={title}
      aria-label={title}
    >
      <span className={styles.cellCode}>{location.code.split("-").at(-1)}</span>
      <span className={styles.cellContent}>
        {location.stock.length === 0
          ? "empty"
          : `${location.stock[0].medicineName}${location.stock.length > 1 ? ` +${location.stock.length - 1}` : ""}`}
      </span>
      <span className={`${styles.num} ${styles.muted}`}>
        {location.occupiedUnits}/{location.capacityUnits}
      </span>
    </Link>
  );
}
