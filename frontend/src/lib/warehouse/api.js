import { createClient } from "@/lib/supabase/server";

// Server-side client for the warehouse API (backend/src/warehouse). It
// forwards the signed-in user's Supabase access token; the backend verifies
// it and applies the role checks. Use only in Server Components and Server
// Actions - the browser never calls the backend directly.

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");

export class WarehouseApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// warehouseApi("/warehouse/inventory", { query: { page: 2 } })
// warehouseApi("/warehouse/movements", { method: "POST", body: {...} })
export async function warehouseApi(path, { method = "GET", query, body } = {}) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new WarehouseApiError(401, "Your session has ended. Sign in again.");

  const url = new URL(`${BACKEND_URL}/api${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WarehouseApiError(
      503,
      `Could not reach the backend at ${BACKEND_URL}. Start it with "cd backend && npm run dev".`
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new WarehouseApiError(
      response.status,
      payload?.error ??
        (response.status === 404
          ? `The backend at ${BACKEND_URL} has no warehouse API. Restart it so it loads the latest code.`
          : `The backend returned HTTP ${response.status}.`),
      payload?.details
    );
  }
  return payload;
}
