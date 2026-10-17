"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Charts for the pharmacy pages. Palette: the validated categorical order
// (blue, orange; checked with the dataviz validator).
// Thin marks, recessive hairline grid, one y-axis per chart, legends for
// two or more series, tooltips on hover; every chart has a table elsewhere
// on its page.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a"];
const MUTED = "#8a8985";
const GRID = "#ebeae6";
const AXIS = { fontSize: 11, fill: "#6b6a66" };

const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};
const num = (v, digits = 1) =>
  v === null || v === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v);

const tooltipStyle = {
  contentStyle: { borderRadius: 8, border: "1px solid #e5e4df", fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,.06)" },
  labelStyle: { color: "#0b0b0b", fontWeight: 500 },
  cursor: { stroke: "#c9c8c2", strokeWidth: 1 },
};

function Frame({ height = 240, label, children }) {
  return (
    <div style={{ width: "100%", height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// Dashboard: revenue per day (single series, no legend).
export function DailyRevenueChart({ data, currency = "LKR" }) {
  return (
    <Frame height={200} label="Revenue per day for the last 14 days">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => num(v / 1000, 0) + "k"} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ fill: "rgba(0,0,0,0.04)" }}
          labelFormatter={shortDate}
          formatter={(value, _name, item) => [
            `${currency} ${num(value, 2)} · ${item.payload.bills} bill(s)${item.payload.synthetic ? " (synthetic)" : ""}`,
            "Revenue",
          ]}
        />
        <Bar dataKey="revenue" fill={SERIES[0]} barSize={18} radius={[4, 4, 0, 0]} />
      </BarChart>
    </Frame>
  );
}

// Analytics: units actually sold per day vs the moving-average estimate made
// from the days before (two series). Days that ended out of stock are marked.
export function ActualVsEstimatedChart({ history, points, unitLabel = "units", windowDays }) {
  const estimates = new Map(points.map((p) => [p.date, p.estimate]));
  const data = history.map((d) => ({
    date: d.date,
    actual: d.sold,
    estimate: estimates.get(d.date) ?? null,
    stockout: d.inStock || d.closingOnHand === null ? null : d.sold,
  }));
  return (
    <Frame height={280} label={`Daily ${unitLabel} sold and the moving-average estimate`}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip {...tooltipStyle} labelFormatter={shortDate} formatter={(value, name) => [`${num(value)} ${unitLabel}`, name]} />
        <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />
        <Line dataKey="actual" name="Actually sold" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line dataKey="estimate" name={`Estimate (${windowDays}-day moving average)`} stroke={SERIES[1]} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Scatter dataKey="stockout" name="Ended out of stock" fill={MUTED} shape="circle" isAnimationActive={false} />
      </ComposedChart>
    </Frame>
  );
}

// Analytics: closing stock per day with the reorder point (single series).
export function StockLevelChart({ history, reorderPoint, unitLabel = "units" }) {
  const data = history.filter((d) => d.closingOnHand !== null).map((d) => ({ date: d.date, stock: d.closingOnHand }));
  return (
    <Frame height={180} label={`Closing stock in ${unitLabel}`}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <Tooltip {...tooltipStyle} labelFormatter={shortDate} formatter={(value) => [`${num(value, 0)} ${unitLabel}`, "Closing stock"]} />
        <Line dataKey="stock" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        {reorderPoint !== null && reorderPoint !== undefined && (
          <ReferenceLine
            y={reorderPoint}
            stroke={MUTED}
            label={{ value: `Reorder point ${num(reorderPoint, 0)}`, position: "insideTopRight", fontSize: 11, fill: "#6b6a66" }}
          />
        )}
      </LineChart>
    </Frame>
  );
}

// Research: actual-vs-estimated error (MAE) per product (single series).
export function EstimateErrorChart({ rows }) {
  const data = rows.map((r) => ({ name: r.name, mae: r.mae }));
  return (
    <Frame height={Math.max(180, data.length * 32 + 40)} label="Mean absolute error of the moving-average estimate by product">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={150} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(0,0,0,0.04)" }} formatter={(value) => [`${num(value, 2)} units/day`, "Mean absolute error"]} />
        <Bar dataKey="mae" fill={SERIES[0]} barSize={14} radius={[0, 4, 4, 0]} />
      </BarChart>
    </Frame>
  );
}

// Research: weekly units sold, split by data source (two series, stacked with a gap).
export function WeeklySalesChart({ data }) {
  const rows = data.map((w) => ({ week: w.week, pos: w.units - w.syntheticUnits, synthetic: w.syntheticUnits }));
  return (
    <Frame height={220} label="Units sold per week by data source">
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="week" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(0,0,0,0.04)" }} labelFormatter={(w) => `Week of ${shortDate(w)}`} formatter={(v, n) => [`${num(v, 0)} units`, n]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="pos" name="POS sales" stackId="s" fill={SERIES[0]} barSize={18} stroke="#ffffff" strokeWidth={2} />
        <Bar dataKey="synthetic" name="Synthetic seed" stackId="s" fill={SERIES[1]} barSize={18} radius={[4, 4, 0, 0]} stroke="#ffffff" strokeWidth={2} />
      </BarChart>
    </Frame>
  );
}

// Research: total closing stock per day (single series).
export function StockTrendChart({ data }) {
  return (
    <Frame height={200} label="Total units in stock per day">
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="day" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} />
        <Tooltip {...tooltipStyle} labelFormatter={shortDate} formatter={(v) => [`${num(v, 0)} units`, "In stock"]} />
        <Line dataKey="units" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </Frame>
  );
}

// Tiny trend line for tables (last 30 days sold).
export function Sparkline({ values, label }) {
  const data = values.map((v, i) => ({ i, v }));
  const total = values.reduce((t, v) => t + v, 0);
  return (
    <div style={{ width: 96, height: 28 }} title={`${label ?? "Last 30 days"}: ${num(total, 0)} sold`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line dataKey="v" stroke={SERIES[0]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
