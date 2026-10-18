"use client";

import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Charts for the cold-chain pages. Colours are the dark-surface steps of the
// validated palette (checked with the dataviz validator against the card
// surface #171717): one blue series per chart, the reserved "critical" status
// colour for readings outside the limits (always with a legend label), and
// recessive chrome. Text uses theme ink, never the series colour. Every chart
// has a table of readings on its page.
const C = {
  series: "#3987e5",
  critical: "#d03b3b",
  surface: "#171717",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  secondary: "#c3c2b7",
  band: "rgba(195, 194, 183, 0.09)",
};
const AXIS_TICK = { fontSize: 11, fill: C.muted };
const TIME_ZONE = "Asia/Colombo";

const timeLabel = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });
const fullTimeLabel = (ms) =>
  new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TIME_ZONE });
const fmt = (value, digits = 1) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
const isSet = (value) => value !== null && value !== undefined;

const FLAG_LABELS = { delayed_upload: "delayed upload", gps_jump: "GPS jump", after_delivery: "after delivery" };

function Frame({ height, label, children }) {
  return (
    <div style={{ width: "100%", height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function TooltipBox({ children }) {
  return <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">{children}</div>;
}

function LegendRow({ items }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(({ key, swatch, label }) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          {swatch}
          {label}
        </span>
      ))}
    </div>
  );
}

const lineKey = <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: C.series }} />;
const bandKey = <span className="inline-block size-3 rounded-sm border" style={{ background: C.band }} />;
const dotKey = (color) => <span className="inline-block size-2.5 rounded-full" style={{ background: color }} />;

// Breaks the line where no reading arrived for longer than `gapMs`, so a
// communication gap shows as a gap rather than an invented straight line.
function withGaps(points, gapMs) {
  const out = [];
  points.forEach((point, i) => {
    if (i > 0 && point.t - points[i - 1].t > gapMs) out.push({ t: points[i - 1].t + 1, gap: true });
    out.push(point);
  });
  return out;
}

// Temperature or humidity over time, with the shipment's safe range as a band.
//   points: [{ t (epoch ms), [field]: number | null, flags: string[] }] oldest first
export function ConditionChart({ points, field, name, unit, min = null, max = null, intervalSeconds = 60, height = 260 }) {
  // Same threshold as the page's gap count and the backend's "online" status.
  const data = withGaps(points, 3 * intervalSeconds * 1000);
  const values = points.map((p) => p[field]).filter(isSet);
  const isOutside = (v) => isSet(v) && ((isSet(max) && v > max) || (isSet(min) && v < min));
  const outsideCount = values.filter(isOutside).length;

  // The y-range always shows the limits, so the band and the readings are read together.
  const bounds = [...values, min, max].filter(isSet);
  const span = Math.max(...bounds) - Math.min(...bounds);
  const pad = Math.max(1, span * 0.12);
  const domain = [Math.floor(Math.min(...bounds) - pad), Math.ceil(Math.max(...bounds) + pad)];

  const renderDot = ({ cx, cy, payload, index }) =>
    isOutside(payload?.[field]) && isSet(cx) && isSet(cy) ? (
      <circle key={`out-${index}`} cx={cx} cy={cy} r={4} fill={C.critical} stroke={C.surface} strokeWidth={2} />
    ) : (
      <g key={`dot-${index}`} />
    );

  return (
    <div>
      <Frame height={height} label={`${name} over time${isSet(min) || isSet(max) ? " with the safe range" : ""}`}>
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={timeLabel}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: C.axis }}
            minTickGap={40}
          />
          <YAxis domain={domain} tick={AXIS_TICK} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(v, 0)} />
          {(isSet(min) || isSet(max)) && (
            <ReferenceArea y1={min ?? domain[0]} y2={max ?? domain[1]} fill={C.band} fillOpacity={1} stroke="none" ifOverflow="hidden" />
          )}
          {isSet(max) && (
            <ReferenceLine
              y={max}
              stroke={C.muted}
              strokeWidth={1}
              label={{ value: `Max ${fmt(max)} ${unit}`, position: "insideTopRight", fill: C.secondary, fontSize: 11 }}
            />
          )}
          {isSet(min) && (
            <ReferenceLine
              y={min}
              stroke={C.muted}
              strokeWidth={1}
              label={{ value: `Min ${fmt(min)} ${unit}`, position: "insideBottomRight", fill: C.secondary, fontSize: 11 }}
            />
          )}
          <Tooltip
            cursor={{ stroke: C.axis, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload;
              if (!active || !point || point.gap) return null;
              const value = point[field];
              const state = !isSet(value) ? "not measured" : isOutside(value) ? (value > max ? "above the limit" : "below the limit") : "within limits";
              return (
                <TooltipBox>
                  <div className="font-medium">{fullTimeLabel(point.t)}</div>
                  <div className="tabular-nums">
                    {isSet(value) ? `${fmt(value, 2)} ${unit}` : "—"} · {state}
                  </div>
                  {point.flags?.length > 0 && <div className="text-muted-foreground">{point.flags.map((f) => FLAG_LABELS[f] ?? f).join(", ")}</div>}
                </TooltipBox>
              );
            }}
          />
          <Line
            dataKey={field}
            name={name}
            stroke={C.series}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            dot={renderDot}
            activeDot={{ r: 4, fill: C.series, stroke: C.surface, strokeWidth: 2 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </Frame>
      {outsideCount > 0 && (
        <LegendRow
          items={[
            { key: "line", swatch: lineKey, label: name },
            { key: "band", swatch: bandKey, label: "Safe range" },
            { key: "out", swatch: dotKey(C.critical), label: `Outside the limits (${outsideCount} reading${outsideCount === 1 ? "" : "s"})` },
          ]}
        />
      )}
    </div>
  );
}

const hiddenShape = () => <g />;
// A marker with a 2px ring in the surface colour, so it stays legible on the track.
function ringDot(color, r = 4) {
  return function RingDot({ cx, cy }) {
    return <circle cx={cx} cy={cy} r={r} fill={color} stroke={C.surface} strokeWidth={2} />;
  };
}

// GPS track without a map library: longitude across, latitude up (not to
// scale). Fixes flagged as GPS jumps are shown on their own, outside the track.
//   points: [{ t, latitude, longitude, speedKmh, flags }] oldest first
export function RouteChart({ points, height = 260 }) {
  const fixes = points.filter((p) => isSet(p.latitude) && isSet(p.longitude));
  if (fixes.length === 0) return null;
  const jumps = fixes.filter((p) => p.flags?.includes("gps_jump"));
  const track = fixes.filter((p) => !p.flags?.includes("gps_jump"));
  const latest = fixes[fixes.length - 1];

  const extent = (key) => {
    const values = track.length ? track.map((p) => p[key]) : fixes.map((p) => p[key]);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = Math.max((hi - lo) * 0.15, 0.002);
    return [lo - pad, hi + pad];
  };

  return (
    <div>
      <Frame height={height} label="GPS track of the shipment">
        <ScatterChart margin={{ top: 12, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={C.grid} />
          <XAxis
            dataKey="longitude"
            type="number"
            name="Longitude"
            domain={extent("longitude")}
            allowDataOverflow
            tickFormatter={(v) => v.toFixed(2)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: C.axis }}
          />
          <YAxis
            dataKey="latitude"
            type="number"
            name="Latitude"
            domain={extent("latitude")}
            allowDataOverflow
            tickFormatter={(v) => v.toFixed(2)}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload;
              if (!active || !point) return null;
              return (
                <TooltipBox>
                  <div className="font-medium">{fullTimeLabel(point.t)}</div>
                  <div className="tabular-nums">
                    {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}
                    {isSet(point.speedKmh) && ` · ${fmt(point.speedKmh)} km/h`}
                  </div>
                  {point.flags?.includes("gps_jump") && <div className="text-muted-foreground">Flagged: implausible jump</div>}
                </TooltipBox>
              );
            }}
          />
          <Scatter data={track} line={{ stroke: C.series, strokeWidth: 2 }} shape={hiddenShape} isAnimationActive={false} />
          {jumps.length > 0 && <Scatter data={jumps} shape={ringDot(C.critical)} isAnimationActive={false} />}
          <Scatter data={[latest]} shape={ringDot(C.series, 5)} isAnimationActive={false} />
        </ScatterChart>
      </Frame>
      <LegendRow
        items={[
          { key: "track", swatch: lineKey, label: "Track (GPS fixes)" },
          { key: "latest", swatch: dotKey(C.series), label: "Latest position" },
          ...(jumps.length ? [{ key: "jump", swatch: dotKey(C.critical), label: `Flagged GPS jump (${jumps.length}); may lie outside this view` }] : []),
        ]}
      />
    </div>
  );
}
