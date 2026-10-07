"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";

// Runs the article collector on the backend (server-to-server; the shared
// INGESTION_API_KEY never reaches the browser). Admins only, like other writes.
export async function refreshArticles() {
  const { profile } = await requireUser();
  if (profile?.role !== "admin" || profile?.status !== "active") {
    return { ok: false, error: "Only admins can collect articles." };
  }

  const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, "");
  const key = process.env.INGESTION_API_KEY;
  if (!backendUrl || !key) {
    return { ok: false, error: "BACKEND_URL and INGESTION_API_KEY must be set in frontend/.env.local." };
  }

  let response;
  try {
    response = await fetch(`${backendUrl}/api/ingestion/articles`, {
      method: "POST",
      headers: { "x-ingestion-key": key },
      cache: "no-store",
      // Slow sources (e.g. WHO) can take a while; each has its own timeout too.
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
  } catch {
    return {
      ok: false,
      error: `Could not reach the backend at ${backendUrl}. Start it with "cd backend && npm run dev".`,
    };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: body.error || `The backend returned HTTP ${response.status}.` };
  }

  revalidatePath("/dashboard/medicine-impact/articles");
  revalidatePath("/dashboard/medicine-impact");
  return {
    ok: true,
    inserted: body.inserted ?? 0,
    results: (body.results ?? []).map(({ source, status, inserted, error }) => ({ source, status, inserted, error })),
  };
}
