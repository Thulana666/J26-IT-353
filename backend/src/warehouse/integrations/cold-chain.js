// Adapter for handing dispatched shipments to Component 2 (IoT cold-chain
// tracking). Uses only Component 2's documented API
// (docs/component-2-cold-chain.md):
//
//   POST /api/cold-chain/shipments { shipmentId, expectedDeliveryAt? }
//     201 monitoring started
//     409 "... already monitored"  -> treated as done (idempotent handoff)
//     409 / 400 / 404 other        -> rejected, not retried
//     401 / 403                    -> rejected (the caller's session or role)
//
// The call is made with the dispatching user's access token, so Component 2
// applies its own role checks. Network errors and 5xx answers are retried a
// few times with a short backoff; anything else is final.

const DEFAULT_DELAYS_MS = [300, 1000];

function defaultBaseUrl() {
  return (process.env.COLD_CHAIN_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { outcome, httpStatus, attempts, body, error } where outcome is
// "sent" (started or already monitored), "rejected" (final 4xx) or
// "unavailable" (no usable answer after the retries).
async function startMonitoring(
  { shipmentId, expectedDeliveryAt = null },
  { token, fetchImpl = fetch, baseUrl = defaultBaseUrl(), delaysMs = DEFAULT_DELAYS_MS, timeoutMs = 10_000 } = {}
) {
  if (!token) return { outcome: "rejected", attempts: 0, error: "No user session to hand the shipment over with" };
  const body = JSON.stringify({ shipmentId, ...(expectedDeliveryAt && { expectedDeliveryAt }) });
  let lastError = null;
  let lastStatus = null;

  for (let attempt = 1; attempt <= delaysMs.length + 1; attempt++) {
    try {
      const response = await fetchImpl(`${baseUrl}/api/cold-chain/shipments`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      lastStatus = response.status;
      if (response.status === 201) {
        return { outcome: "sent", httpStatus: 201, attempts: attempt, body: payload };
      }
      if (response.status === 409 && /already monitored/i.test(payload.error ?? "")) {
        return { outcome: "sent", httpStatus: 409, attempts: attempt, body: payload, alreadyMonitored: true };
      }
      if (response.status < 500) {
        return {
          outcome: "rejected",
          httpStatus: response.status,
          attempts: attempt,
          body: payload,
          error: payload.error ?? `Cold-chain service answered HTTP ${response.status}`,
        };
      }
      lastError = payload.error ?? `Cold-chain service answered HTTP ${response.status}`;
    } catch (error) {
      lastError = `Cold-chain service not reachable: ${error.message}`;
    }
    if (attempt <= delaysMs.length) await sleep(delaysMs[attempt - 1]);
  }
  return { outcome: "unavailable", httpStatus: lastStatus, attempts: delaysMs.length + 1, error: lastError };
}

module.exports = { startMonitoring, defaultBaseUrl };
