// Risk predictors. Storage, alerts and the dashboard depend only on this
// interface:
//
//   provider.predict({ readings, limits, trip, destination, origin, now })
//     -> Promise<{ riskLevel, riskProbability, riskType, explanation, factors,
//                  horizonMinutes, readingsUsed, dataUntil, modelName,
//                  modelVersion, isPrototype, temperatureRisk?, delayRisk?, details? }>
//
// COLD_CHAIN_RISK_MODEL selects it:
//   prototype (default)  rule-based stand-in (./prototype.js), marked is_prototype
//   trained              the trained models served by the AI service
//                        (POST /cold-chain/predict): temperature-excursion and
//                        delivery-delay risk, combined there. ("cnn_lstm" is
//                        the old name of this setting.)
//
// When the AI service has no trained model installed (501), cannot estimate a
// risk yet (422, e.g. the trip just started) or cannot be reached, the
// prototype answers instead. Its result stays labelled as the prototype
// (is_prototype, model prototype_rules) with the reason in details.fallback, so
// a rule-based result is never presented as a trained model's.

const { MODEL, predictRisk } = require("./prototype");

const prototype = {
  ...MODEL,
  async predict(input) {
    return { ...predictRisk(input), ...MODEL };
  },
};

const aiUrl = () => (process.env.AI_SERVICE_URL || process.env.SPATIAL_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");
const TIMEOUT_MS = 10_000;

function requestBody({ readings, limits, trip, destination, origin, now }) {
  return {
    readings: readings.map((r) => ({ ...r, recordedAt: new Date(r.recordedAt).toISOString() })),
    limits,
    trip,
    destination: destination ?? null,
    origin: origin ?? null,
    now: new Date(now).toISOString(),
  };
}

// The AI service's prediction, or { fallback } saying why there is none.
async function askAiService(input) {
  const url = aiUrl();
  let response;
  try {
    response = await fetch(`${url}/cold-chain/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(input)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { fallback: { reason: "ai_service_unreachable", message: `The AI service is not reachable at ${url} (${error.message})` } };
  }
  const body = await response.json().catch(() => ({}));
  const message = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
  if (response.status === 501) return { fallback: { reason: "no_trained_model", status: 501, message } };
  if (response.status === 422) return { fallback: { reason: "not_enough_data", status: 422, message } };
  if (!response.ok) return { fallback: { reason: "ai_service_error", status: response.status, message } };
  return { prediction: body };
}

const trained = {
  modelName: "trained",
  isPrototype: false,
  async predict(input) {
    const { prediction, fallback } = await askAiService(input);
    if (prediction) {
      const { components, combination, cleaning, ...result } = prediction;
      return { ...result, isPrototype: false, details: { components, combination, cleaning } };
    }
    if (!["no_trained_model", "not_enough_data"].includes(fallback.reason)) {
      console.warn(`[cold-chain] trained risk model unavailable, using the prototype: ${fallback.message}`);
    }
    const result = await prototype.predict(input);
    return { ...result, details: { fallback } };
  },
};

function getRiskProvider() {
  return ["trained", "cnn_lstm"].includes(process.env.COLD_CHAIN_RISK_MODEL) ? trained : prototype;
}

module.exports = { getRiskProvider, prototype, trained, requestBody };
