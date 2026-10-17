// HTTP client for the Python spatial allocation service (ai-service/).
// The service is stateless: the backend sends the batch and the current
// warehouse state, the service returns ranked storage locations.

const { HttpError } = require("./errors");

const SPATIAL_URL = (process.env.SPATIAL_SERVICE_URL || "http://localhost:8000").replace(/\/$/, "");
const TIMEOUT_MS = 10_000;

async function call(path, options = {}) {
  let response;
  try {
    response = await fetch(`${SPATIAL_URL}${path}`, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new HttpError(
      503,
      `The spatial allocation service is not reachable at ${SPATIAL_URL}. Start it from ai-service/ (see docs/component-3-warehouse.md).`
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(502, `The spatial allocation service returned HTTP ${response.status}`, { service: body.detail ?? body });
  }
  return body;
}

function recommend(payload) {
  return call("/warehouse/spatial/recommend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function status() {
  try {
    const body = await call("/health");
    return { available: true, url: SPATIAL_URL, service: body };
  } catch (error) {
    return { available: false, url: SPATIAL_URL, error: error.message };
  }
}

module.exports = { recommend, status, SPATIAL_URL };
