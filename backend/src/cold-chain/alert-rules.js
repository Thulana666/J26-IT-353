// Observed-condition alerts (pure functions).
//
// A measured temperature or humidity outside the shipment's configured limits,
// or (temperature only) within TEMP_WARNING_MARGIN_C of them. These are
// measurements, not predictions; predicted risks (rising trends, delays, route
// anomalies) come from the risk predictor.
//
// One active alert per condition (dedupe key), e.g. 'temperature_excursion:above':
//   * close to the limit -> medium, beyond it -> high; an alert only escalates,
//     and an escalated alert that was acknowledged is opened again;
//   * it resolves when the newest reading is back inside the safe band, so each
//     excursion is one record with its first/last time and peak value.

const { TEMP_WARNING_MARGIN_C } = require("./constants");

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };
const isSet = (value) => value !== null && value !== undefined;

function classifyTemperature(value, { tempMinC, tempMaxC }) {
  if (!isSet(value)) return null;
  // The warning band never covers more than a quarter of the allowed range.
  const band = Math.min(TEMP_WARNING_MARGIN_C, (tempMaxC - tempMinC) / 4);
  if (value > tempMaxC) return { side: "above", level: "high", limit: tempMaxC };
  if (value < tempMinC) return { side: "below", level: "high", limit: tempMinC };
  if (value > tempMaxC - band) return { side: "above", level: "medium", limit: tempMaxC };
  if (value < tempMinC + band) return { side: "below", level: "medium", limit: tempMinC };
  return null;
}

function classifyHumidity(value, { humidityMinPct, humidityMaxPct }) {
  if (!isSet(value)) return null;
  if (isSet(humidityMaxPct) && value > humidityMaxPct) return { side: "above", level: "medium", limit: humidityMaxPct };
  if (isSet(humidityMinPct) && value < humidityMinPct) return { side: "below", level: "medium", limit: humidityMinPct };
  return null;
}

const MEASURES = [
  { riskType: "temperature_excursion", field: "temperatureC", unit: "°C", classify: classifyTemperature },
  { riskType: "humidity_deviation", field: "humidityPct", unit: "% RH", classify: classifyHumidity },
];

const measureOf = (dedupeKey) => MEASURES.find((m) => dedupeKey.startsWith(`${m.riskType}:`));
const ms = (value) => (typeof value === "number" ? value : Date.parse(value));
const fmt = (value, unit) => `${Math.round(value * 10) / 10} ${unit}`;

// Wording states what was measured; it never claims the product is damaged.
function describe(measure, side, level, limit, peak) {
  const { unit } = measure;
  if (measure.riskType === "temperature_excursion") {
    if (level === "high") {
      return {
        title: `Temperature ${side} the safe range`,
        message:
          `Measured temperature reached ${fmt(peak, unit)}, ${side} the ${fmt(limit, unit)} limit for this shipment. ` +
          "Potential temperature excursion: check the products' stability data before use.",
      };
    }
    return {
      title: `Temperature approaching the ${side === "above" ? "upper" : "lower"} limit`,
      message: `Measured temperature reached ${fmt(peak, unit)}, close to the ${fmt(limit, unit)} limit for this shipment.`,
    };
  }
  return {
    title: `Humidity ${side} the configured range`,
    message: `Measured humidity reached ${fmt(peak, unit)}, ${side} the configured ${fmt(limit, unit)}.`,
  };
}

// Plans alert changes for newly stored readings.
//   readings    new readings: { recordedAt, temperatureC, humidityPct }
//   latest      the shipment's newest stored reading (decides resolution)
//   openAlerts  the shipment's unresolved observed alerts (database rows)
//   limits      { tempMinC, tempMaxC, humidityMinPct, humidityMaxPct }
// Returns { upserts, resolves }: upserts carry `id` when they update an alert.
function planObservedAlerts({ readings, latest, openAlerts, limits }) {
  const existingByKey = new Map(openAlerts.map((alert) => [alert.dedupe_key, alert]));

  // Group the new readings' detections by condition.
  const detections = new Map();
  for (const reading of readings) {
    const at = ms(reading.recordedAt);
    for (const measure of MEASURES) {
      const value = reading[measure.field];
      const hit = measure.classify(value, limits);
      if (!hit) continue;
      const key = `${measure.riskType}:${hit.side}`;
      const d = detections.get(key);
      if (!d) {
        detections.set(key, { measure, side: hit.side, level: hit.level, limit: hit.limit, first: at, last: at, lastValue: value, peak: value, count: 1 });
        continue;
      }
      d.count += 1;
      if (LEVEL_RANK[hit.level] > LEVEL_RANK[d.level]) d.level = hit.level;
      d.first = Math.min(d.first, at);
      if (at >= d.last) [d.last, d.lastValue] = [at, value];
      d.peak = hit.side === "above" ? Math.max(d.peak, value) : Math.min(d.peak, value);
    }
  }

  // Is this condition over, judged by the newest reading?
  const latestAt = latest ? ms(latest.recordedAt) : null;
  const isOver = (key, lastDetectedAt) => {
    if (!latest) return false;
    const measure = measureOf(key);
    const value = latest[measure.field];
    if (!isSet(value) || latestAt <= lastDetectedAt) return false;
    const hit = measure.classify(value, limits);
    return !hit || hit.side !== key.split(":")[1];
  };

  const upserts = [];
  for (const [key, d] of detections) {
    const existing = existingByKey.get(key);
    const previousPeak = existing?.details?.peakValue;
    const peak = !isSet(previousPeak) ? d.peak : d.side === "above" ? Math.max(previousPeak, d.peak) : Math.min(previousPeak, d.peak);
    const level = existing && LEVEL_RANK[existing.risk_level] > LEVEL_RANK[d.level] ? existing.risk_level : d.level;
    const first = existing ? Math.min(ms(existing.first_detected_at), d.first) : d.first;
    const existingLast = existing ? ms(existing.last_detected_at) : -Infinity;
    const last = Math.max(existingLast, d.last);
    const lastValue = d.last >= existingLast ? d.lastValue : existing.details?.lastValue ?? d.lastValue;
    const escalated = existing && LEVEL_RANK[level] > LEVEL_RANK[existing.risk_level];

    upserts.push({
      id: existing?.id ?? null,
      dedupeKey: key,
      riskType: d.measure.riskType,
      riskLevel: level,
      ...describe(d.measure, d.side, level, d.limit, peak),
      details: { measure: d.measure.field, side: d.side, limit: d.limit, unit: d.measure.unit, peakValue: peak, lastValue },
      firstDetectedAt: new Date(first).toISOString(),
      lastDetectedAt: new Date(last).toISOString(),
      occurrences: (existing?.occurrences ?? 0) + d.count,
      reopen: Boolean(escalated && existing.status === "acknowledged"),
      resolve: isOver(key, last),
    });
  }

  const resolves = openAlerts
    .filter((alert) => alert.basis === "observed" && measureOf(alert.dedupe_key) && !detections.has(alert.dedupe_key))
    .filter((alert) => isOver(alert.dedupe_key, ms(alert.last_detected_at)))
    .map((alert) => alert.id);

  return { upserts, resolves };
}

module.exports = { classifyTemperature, classifyHumidity, planObservedAlerts };
