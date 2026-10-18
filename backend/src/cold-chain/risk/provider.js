// Risk predictors. Storage, alerts and the dashboard depend only on this
// interface, so the trained CNN-LSTM model can replace the temporary
// prototype without other changes:
//
//   provider.predict({ readings, limits, trip, destination, now })
//     -> Promise<{ riskLevel, riskProbability, riskType, explanation, factors,
//                  horizonMinutes, readingsUsed, dataUntil,
//                  modelName, modelVersion, isPrototype }>
//
// COLD_CHAIN_RISK_MODEL selects it:
//   prototype (default)  rule-based stand-in (./prototype.js), marked is_prototype
//   cnn_lstm             the ai-service model (POST /cold-chain/predict). The
//                        model is not trained yet: the service answers 501 and
//                        no prediction is stored (there is no silent fallback to
//                        the prototype, so results are never mislabelled).

const { HttpError } = require("../errors");
const { MODEL, predictRisk } = require("./prototype");

const prototype = {
  ...MODEL,
  async predict(input) {
    return { ...predictRisk(input), ...MODEL };
  },
};

const AI_URL = (process.env.AI_SERVICE_URL || process.env.SPATIAL_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");

const cnnLstm = {
  modelName: "cnn_lstm",
  isPrototype: false,
  async predict({ readings, limits, trip, destination, now }) {
    let response;
    try {
      response = await fetch(`${AI_URL}/cold-chain/predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          readings: readings.map((r) => ({ ...r, recordedAt: new Date(r.recordedAt).toISOString() })),
          limits,
          trip,
          destination,
          now: new Date(now).toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new HttpError(503, `The AI service is not reachable at ${AI_URL}`);
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 501) throw new HttpError(503, "The CNN-LSTM model is not trained yet; no prediction was made");
    if (!response.ok) throw new HttpError(502, `The AI service answered HTTP ${response.status}`, { service: body.detail ?? body });
    return { ...body, modelName: body.modelName ?? "cnn_lstm", isPrototype: false };
  },
};

function getRiskProvider() {
  return process.env.COLD_CHAIN_RISK_MODEL === "cnn_lstm" ? cnnLstm : prototype;
}

module.exports = { getRiskProvider, prototype, cnnLstm };
