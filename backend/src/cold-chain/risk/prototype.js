// TEMPORARY prototype risk predictor (rule-based). This is NOT the research
// model: it is a set of transparent heuristics so that storage, alerts and
// the dashboard work end to end until the CNN-LSTM model (ai-service) is
// trained. Its "probabilities" are heuristic scores between 0 and 1, not
// calibrated probabilities, and every prediction it produces is marked
// is_prototype = true. Pure functions: no database access.
//
// predictRisk({ readings, limits, trip, destination, now })
//   readings     oldest first: { recordedAt (epoch ms), temperatureC, humidityPct,
//                latitude, longitude, speedKmh, qualityFlags }
//   limits       { tempMinC, tempMaxC, humidityMinPct, humidityMaxPct }
//   trip         { expectedDeliveryAt, startedAt, intervalSeconds }
//   destination  { latitude, longitude } of the pharmacy, or null
// -> { riskLevel, riskProbability, riskType, explanation, factors, horizonMinutes, readingsUsed, dataUntil }

const { haversineKm } = require("../quality");
const { RISK_THRESHOLDS } = require("../constants");

const MODEL = { modelName: "prototype_rules", modelVersion: "0.1", isPrototype: true };
const HORIZON_MINUTES = 60;
const TREND_WINDOW_MINUTES = 30;
const MIN = 60_000;
// Assumed speed when the truck has not been seen moving recently.
const DEFAULT_SPEED_KMH = 30;

const isSet = (value) => value !== null && value !== undefined;
const logistic = (x) => 1 / (1 + Math.exp(-x));
const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" });

function levelOf(probability) {
  if (probability >= RISK_THRESHOLDS.high) return "high";
  if (probability >= RISK_THRESHOLDS.medium) return "medium";
  return "low";
}

// Least-squares slope (value per minute) of [{ t (ms), v }].
function slopePerMinute(points) {
  const n = points.length;
  const ts = points.map((p) => (p.t - points[0].t) / MIN);
  const meanT = ts.reduce((a, b) => a + b, 0) / n;
  const meanV = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0;
  let den = 0;
  points.forEach((p, i) => {
    num += (ts[i] - meanT) * (p.v - meanV);
    den += (ts[i] - meanT) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

// Risk that a measurement leaves its range within the horizon, from its
// position in the range and its recent trend.
function measureRisk({ readings, field, label, unit, min, max, now }) {
  if (!isSet(min) && !isSet(max)) {
    return { probability: 0, explanation: `No ${label} limits are configured.`, details: { configured: false } };
  }
  const points = readings
    .filter((r) => isSet(r[field]) && r.recordedAt >= now - TREND_WINDOW_MINUTES * MIN)
    .map((r) => ({ t: r.recordedAt, v: r[field] }));
  if (points.length === 0) {
    return { probability: 0, explanation: `No ${label} readings in the last ${TREND_WINDOW_MINUTES} min.`, details: { readings: 0 } };
  }
  const name = label[0].toUpperCase() + label.slice(1);
  const latest = points[points.length - 1].v;
  if ((isSet(max) && latest > max) || (isSet(min) && latest < min)) {
    const limit = isSet(max) && latest > max ? max : min;
    return {
      probability: 0.95,
      explanation: `${name} is outside the safe range now (${round(latest, 1)} ${unit}, limit ${limit} ${unit}).`,
      details: { latest, limit, outside: true },
    };
  }

  // A trend needs a few points; slopes below this are treated as flat.
  const slope = points.length >= 5 ? slopePerMinute(points) : 0;
  let minutesToLimit = null;
  let limit = null;
  if (slope > 0.005 && isSet(max)) [minutesToLimit, limit] = [(max - latest) / slope, max];
  else if (slope < -0.005 && isSet(min)) [minutesToLimit, limit] = [(latest - min) / -slope, min];
  // 30 min to the limit -> 0.5, 15 min -> 0.87, 60 min -> 0.02.
  const trend = minutesToLimit === null ? 0 : logistic((30 - minutesToLimit) / 8);

  const range = isSet(min) && isSet(max) ? max - min : 10;
  const margin = Math.min(isSet(max) ? max - latest : Infinity, isSet(min) ? latest - min : Infinity);
  const near = margin < 0.1 * range ? 0.35 : 0.03;
  const probability = Math.max(trend, near);

  let explanation;
  if (minutesToLimit !== null && minutesToLimit <= HORIZON_MINUTES && trend >= near) {
    explanation =
      `${name} is ${slope > 0 ? "rising" : "falling"} about ${round(Math.abs(slope), 2)} ${unit}/min and ` +
      `may cross the ${limit} ${unit} limit in about ${Math.max(1, round(minutesToLimit))} min.`;
  } else if (near > 0.1) {
    const nearLimit = isSet(max) && max - latest === margin ? max : min;
    explanation = `${name} is close to the ${nearLimit} ${unit} limit (${round(latest, 1)} ${unit}).`;
  } else {
    explanation = `${name} is within the safe range with no trend towards a limit.`;
  }
  return {
    probability,
    explanation,
    details: { latest, slopePerMinute: round(slope, 4), minutesToLimit: minutesToLimit === null ? null : round(minutesToLimit), limit },
  };
}

// Risk of arriving after the expected delivery time: remaining distance at the
// recent average speed, when the destination has coordinates.
function deliveryRisk({ readings, trip, destination, now }) {
  const expected = trip.expectedDeliveryAt ? Date.parse(trip.expectedDeliveryAt) : null;
  if (expected === null) return { probability: 0, explanation: "No expected delivery time is set.", details: {} };
  const minutesLeft = (expected - now) / MIN;
  if (minutesLeft < 0) {
    return {
      probability: 0.95,
      explanation: `The expected delivery time (${clock(expected)}) passed ${round(-minutesLeft)} min ago.`,
      details: { minutesLate: round(-minutesLeft) },
    };
  }
  const fix = [...readings].reverse().find((r) => isSet(r.latitude) && !r.qualityFlags?.includes("gps_jump"));
  if (!destination || !fix) {
    return {
      probability: minutesLeft < 15 ? 0.3 : 0.05,
      explanation: `${round(minutesLeft)} min remain until the expected delivery time; ${
        destination ? "no GPS fix yet" : "the pharmacy has no coordinates"
      }, so the remaining distance is unknown.`,
      details: { minutesLeft: round(minutesLeft) },
    };
  }
  const remainingKm = haversineKm(fix, destination);
  const moving = readings.filter((r) => r.recordedAt >= now - HORIZON_MINUTES * MIN && isSet(r.speedKmh) && r.speedKmh > 3);
  const speed = moving.length ? moving.reduce((sum, r) => sum + r.speedKmh, 0) / moving.length : DEFAULT_SPEED_KMH;
  const eta = now + (remainingKm / speed) * 60 * MIN;
  const slackMinutes = (expected - eta) / MIN;
  // On time -> 0.5 at zero slack; 15 min late -> 0.87; 20 min early -> 0.08.
  const probability = logistic(-slackMinutes / 8);
  return {
    probability,
    explanation:
      `About ${round(remainingKm, 1)} km remain; at ${moving.length ? "the recent average speed" : "an assumed speed"} of ` +
      `${round(speed)} km/h the estimated arrival is ${clock(eta)}, ${round(Math.abs(slackMinutes))} min ` +
      `${slackMinutes < 0 ? "after" : "before"} the expected time.`,
    details: { remainingKm: round(remainingKm, 2), averageSpeedKmh: round(speed, 1), estimatedArrival: new Date(eta).toISOString(), slackMinutes: round(slackMinutes) },
  };
}

// Route / logistics risk: interrupted data, a long stop, implausible GPS jumps.
function routeRisk({ readings, trip, now }) {
  const lastAt = readings.length ? readings[readings.length - 1].recordedAt : trip.startedAt ? Date.parse(trip.startedAt) : now;
  const silentMinutes = Math.max(0, (now - lastAt) / MIN);
  const expectedGap = (3 * (trip.intervalSeconds ?? 60)) / 60;
  const offline = silentMinutes > expectedGap ? logistic((silentMinutes - 15) / 5) : 0;

  let stopMinutes = 0;
  for (let i = readings.length - 1; i >= 0 && isSet(readings[i].speedKmh) && readings[i].speedKmh < 2; i--) {
    stopMinutes = (readings[readings.length - 1].recordedAt - readings[i].recordedAt) / MIN;
  }
  const stopped = logistic((stopMinutes - 30) / 8);

  const jumps = readings.filter((r) => r.recordedAt >= now - HORIZON_MINUTES * MIN && r.qualityFlags?.includes("gps_jump")).length;
  const jumpy = jumps ? Math.min(0.4 + 0.15 * jumps, 0.85) : 0;

  const parts = [
    [offline, `No reading for ${round(silentMinutes)} min (sensor or network interruption).`],
    [stopped, `The truck has not moved for about ${round(stopMinutes)} min.`],
    [jumpy, `${jumps} implausible GPS jump(s) in the last hour.`],
  ].sort((a, b) => b[0] - a[0]);
  const probability = Math.max(parts[0][0], 0.02);
  return {
    probability,
    explanation: parts[0][0] >= 0.1 ? parts[0][1] : "Route, movement and data connection look normal.",
    details: { silentMinutes: round(silentMinutes), stopMinutes: round(stopMinutes), gpsJumps: jumps },
  };
}

function predictRisk({ readings, limits, trip, destination = null, now = Date.now() }) {
  const factors = {
    temperature_excursion: measureRisk({
      readings, field: "temperatureC", label: "temperature", unit: "°C", min: limits.tempMinC, max: limits.tempMaxC, now,
    }),
    humidity_deviation: measureRisk({
      readings, field: "humidityPct", label: "humidity", unit: "%RH", min: limits.humidityMinPct, max: limits.humidityMaxPct, now,
    }),
    delivery_delay: deliveryRisk({ readings, trip, destination, now }),
    route_anomaly: routeRisk({ readings, trip, now }),
  };
  for (const factor of Object.values(factors)) factor.probability = round(factor.probability, 4);

  // Probability that at least one of the risks occurs (treated as independent).
  const combined = 1 - Object.values(factors).reduce((acc, f) => acc * (1 - f.probability), 1);
  const ranked = Object.entries(factors).sort((a, b) => b[1].probability - a[1].probability);
  const significant = ranked.filter(([, f]) => f.probability >= 0.5);

  let riskType = null;
  let explanation = "No significant cold-chain or logistics risk is detected in the recent data.";
  if (significant.length >= 2) {
    riskType = "combined";
    explanation = `Several risks at once: ${significant.slice(0, 2).map(([, f]) => f.explanation).join(" ")}`;
  } else if (ranked[0][1].probability >= RISK_THRESHOLDS.medium) {
    riskType = ranked[0][0];
    explanation = ranked[0][1].explanation;
  }
  const window = readings.filter((r) => r.recordedAt >= now - HORIZON_MINUTES * MIN);
  return {
    riskLevel: levelOf(combined),
    riskProbability: round(combined, 4),
    riskType,
    explanation,
    factors,
    horizonMinutes: HORIZON_MINUTES,
    readingsUsed: window.length,
    dataUntil: readings.length ? new Date(readings[readings.length - 1].recordedAt).toISOString() : null,
  };
}

module.exports = { MODEL, HORIZON_MINUTES, predictRisk, levelOf, slopePerMinute };
