import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

// Server-side client for the pharmacy API (backend/src/pharmacy). Like the
// warehouse client it forwards the signed-in user's Supabase access token;
// the backend verifies it and applies every role and pharmacy check. For
// admins it also sends the pharmacy chosen in the switcher (a cookie); the
// backend ignores it for pharmacy staff, who always work in their own.
// Use only in Server Components and Server Actions.

const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:5000").replace(/\/$/, "");

export const PHARMACY_COOKIE = "pt_pharmacy";

export class PharmacyApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// pharmacyApi("/pharmacy/inventory", { query: { q: "para" } })
// pharmacyApi("/pharmacy/sales", { method: "POST", body: {...} })
export async function pharmacyApi(path, { method = "GET", query, body, timeoutMs = 30_000 } = {}) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new PharmacyApiError(401, "Your session has ended. Sign in again.");
  const pharmacyId = (await cookies()).get(PHARMACY_COOKIE)?.value;

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
        ...(pharmacyId && { "x-pharmacy-id": pharmacyId }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new PharmacyApiError(
      503,
      error?.name === "TimeoutError"
        ? "The backend took too long to answer."
        : `Could not reach the backend at ${BACKEND_URL}. Start it with "cd backend && npm run dev".`
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new PharmacyApiError(
      response.status,
      payload?.error ??
        (response.status === 404
          ? `The backend at ${BACKEND_URL} has no pharmacy API. Restart it so it loads the latest code.`
          : `The backend returned HTTP ${response.status}.`),
      payload?.details
    );
  }
  return payload;
}
