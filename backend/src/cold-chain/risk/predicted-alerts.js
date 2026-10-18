// Predicted-risk alerts (pure functions). One active alert per predicted risk
// (dedupe key 'predicted:<risk type>'): it opens when the risk reaches
// PREDICTED_ALERT.open, is updated while it stays, only escalates, and
// resolves below PREDICTED_ALERT.close. A predicted temperature or humidity
// alert is not opened while an observed (measured) alert for that measurement
// is active: the measurement already says more. Wording states a potential
// risk with its probability, never that a product is damaged.

const { PREDICTED_ALERT } = require("../constants");

const LEVEL_RANK = { low: 0, medium: 1, high: 2 };

const TITLES = {
  temperature_excursion: "Potential temperature excursion",
  humidity_deviation: "Potential humidity deviation",
  delivery_delay: "Possible delivery delay",
  route_anomaly: "Route / logistics risk",
  combined: "Combined cold-chain risk",
};

const percent = (p) => `${Math.round(p * 100)}%`;

function modelLabel(prediction) {
  return prediction.isPrototype ? "prototype rule-based predictor" : `${prediction.modelName} ${prediction.modelVersion ?? ""}`.trim();
}

// prediction: provider output. openAlerts: the shipment's unresolved predicted
// alerts (rows). observedOpen: { temperature_excursion: bool, humidity_deviation: bool }.
// Returns { upserts, resolves } like planObservedAlerts.
function planPredictedAlerts({ prediction, openAlerts, observedOpen = {}, now = Date.now() }) {
  const byKey = new Map(openAlerts.map((alert) => [alert.dedupe_key, alert]));
  const at = new Date(now).toISOString();
  const upserts = [];
  const resolves = [];

  const consider = (riskType, probability, explanation, { open, close, suppressed = false }) => {
    const key = `predicted:${riskType}`;
    const existing = byKey.get(key);
    if (probability >= open && !suppressed) {
      const level = probability >= PREDICTED_ALERT.high ? "high" : "medium";
      const riskLevel = existing && LEVEL_RANK[existing.risk_level] > LEVEL_RANK[level] ? existing.risk_level : level;
      upserts.push({
        id: existing?.id ?? null,
        dedupeKey: key,
        riskType,
        riskLevel,
        riskProbability: probability,
        title: TITLES[riskType],
        message: `${explanation} Predicted risk ${percent(probability)} (${modelLabel(prediction)}).`,
        details: { model: prediction.modelName, modelVersion: prediction.modelVersion, isPrototype: prediction.isPrototype, horizonMinutes: prediction.horizonMinutes },
        firstDetectedAt: existing?.first_detected_at ?? at,
        lastDetectedAt: at,
        occurrences: (existing?.occurrences ?? 0) + 1,
        reopen: Boolean(existing && existing.status === "acknowledged" && LEVEL_RANK[riskLevel] > LEVEL_RANK[existing.risk_level]),
        resolve: false,
      });
    } else if (existing && (probability < close || suppressed)) {
      resolves.push(existing.id);
    }
  };

  for (const [riskType, factor] of Object.entries(prediction.factors ?? {})) {
    if (!TITLES[riskType]) continue;
    consider(riskType, factor.probability, factor.explanation, {
      open: PREDICTED_ALERT.open,
      close: PREDICTED_ALERT.close,
      suppressed: Boolean(observedOpen[riskType]),
    });
  }
  const isCombined = prediction.riskType === "combined";
  consider("combined", isCombined ? prediction.riskProbability : 0, prediction.explanation, {
    open: PREDICTED_ALERT.combinedOpen,
    close: PREDICTED_ALERT.combinedClose,
  });
  return { upserts, resolves };
}

module.exports = { planPredictedAlerts, TITLES };
