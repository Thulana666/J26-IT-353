import { MapBadge, ToneBadge } from "@/components/cold-chain/badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  LIMIT_STATE,
  QUALITY_FLAGS,
  formatCoordinate,
  formatDateTime,
  formatHumidity,
  formatSpeed,
  formatTemp,
  limitState,
} from "@/lib/cold-chain/format";

// The newest readings as a table (the charts' table view), with their
// data-quality flags. Values are shown exactly as stored.
export function ReadingsTable({ readings, limits }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Recorded</TableHead>
          <TableHead className="text-right">Temperature</TableHead>
          <TableHead className="text-right">Humidity</TableHead>
          <TableHead>Position</TableHead>
          <TableHead className="text-right">Speed</TableHead>
          <TableHead>Data quality</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {readings.map((reading) => {
          const temperature = limitState(reading.temperatureC, limits.tempMinC, limits.tempMaxC);
          const humidity = limitState(reading.humidityPct, limits.humidityMinPct, limits.humidityMaxPct);
          return (
            <TableRow key={reading.id}>
              <TableCell className="whitespace-nowrap">{formatDateTime(reading.recordedAt)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatTemp(reading.temperatureC)}
                {temperature && temperature !== "ok" && <MapBadge map={LIMIT_STATE} value={temperature} className="ml-1.5" />}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatHumidity(reading.humidityPct)}
                {humidity && humidity !== "ok" && <MapBadge map={LIMIT_STATE} value={humidity} className="ml-1.5" />}
              </TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {reading.latitude === null ? <span className="text-muted-foreground">no fix</span> : `${formatCoordinate(reading.latitude)}, ${formatCoordinate(reading.longitude)}`}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatSpeed(reading.speedKmh)}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {reading.qualityFlags.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                  {reading.qualityFlags.map((flag) => (
                    <ToneBadge key={flag} tone={flag === "gps_jump" ? "amber" : "gray"} title={QUALITY_FLAGS[flag]?.[1]}>
                      {QUALITY_FLAGS[flag]?.[0] ?? flag}
                    </ToneBadge>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
