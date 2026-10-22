// Calls the pharmacy demand model in the Python AI service (scikit-learn,
// ai-service/pharmacy_demand, POST /pharmacy-demand/train).
//
// The backend sends each product's daily series; the service is stateless and
// has no database access. It trains and evaluates the model and returns the
// forecasts, which the backend stores with the forecast run. The result is
// validated here before it is used. When the service is unreachable or answers
// with something unusable, the caller uses the moving average instead.

const TIMEOUT_MS = Number(process.env.PHARMACY_AI_TIMEOUT_MS) || 20_000;
const aiUrl = () => (process.env.AI_SERVICE_URL || process.env.SPATIAL_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const isoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const metric = (m) => m && (m.mae === null || finite(m.mae)) && (m.rmse === null || finite(m.rmse));
const period = (p) => p && Number.isInteger(p.observations) && isoDate(p.from) && isoDate(p.to);
const forecast = (f, horizonDays) =>
  f === null || (isoDate(f?.start) && Array.isArray(f.values) && f.values.length === horizonDays && f.values.every((v) => finite(v) && v >= 0));

// A trained result the rest of the analytics can rely on.
function validResult(body, horizonDays) {
  if (body?.status !== "trained") return false;
  const ev = body.evaluation;
  return (
    Array.isArray(body.features) &&
    Array.isArray(body.coefficients) &&
    body.coefficients.length === body.features.length &&
    body.coefficients.every(finite) &&
    Number.isInteger(body.rows) &&
    period(ev?.train) &&
    period(ev?.test) &&
    metric(ev.overall?.linearRegression) &&
    metric(ev.overall?.movingAverage) &&
    ev.perSeries !== null &&
    typeof ev.perSeries === "object" &&
    Object.values(ev.perSeries).every(
      (s) =>
        Number.isInteger(s.observations) &&
        metric(s.linearRegression) &&
        metric(s.movingAverage) &&
        (s.residualSd === null || finite(s.residualSd)) &&
        typeof s.selected === "boolean"
    ) &&
    body.forecasts !== null &&
    typeof body.forecasts === "object" &&
    Object.values(body.forecasts).every((f) => forecast(f, horizonDays))
  );
}

// series: [{ id, days: [{ date, sold, closingOnHand }] }], each ending on the last recorded day.
// -> { result } (status "trained" or "insufficient_history") | { fallback: { reason, message } }
async function trainOnAiService(series, { testDays, lambda, horizonDays, trainFrom, trainTo }) {
  const url = aiUrl();
  let response;
  try {
    response = await fetch(`${url}/pharmacy-demand/train`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        series: series.map(({ id, days }) => ({ id, days: days.map((d) => ({ date: d.date, sold: d.sold, closingOnHand: d.closingOnHand })) })),
        testDays,
        lambda,
        horizonDays,
        trainFrom,
        trainTo,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { fallback: { reason: "ai_service_unreachable", message: `The AI service is not reachable at ${url} (${error.message})` } };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.detail;
    return { fallback: { reason: "ai_service_error", status: response.status, message: typeof detail === "string" ? detail : JSON.stringify(detail ?? body) } };
  }
  if (body?.status === "insufficient_history") return { result: { status: "insufficient_history" } };
  if (!validResult(body, horizonDays)) return { fallback: { reason: "invalid_response", message: "The AI service returned an unexpected training result." } };
  return { result: body };
}

module.exports = { trainOnAiService, validResult };
