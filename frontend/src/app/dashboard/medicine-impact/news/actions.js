"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";

// Server-to-server calls to the backend's news pipeline. The shared
// INGESTION_API_KEY and the private AI service never reach the browser.
// Admins only, like the other collection/analysis actions.

async function callBackend(path, init = {}) {
  const { profile } = await requireUser();
  if (profile?.role !== "admin" || profile?.status !== "active") {
    return { ok: false, error: "Only admins can run the AI services." };
  }
  const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, "");
  const key = process.env.INGESTION_API_KEY;
  if (!backendUrl || !key) {
    return { ok: false, error: "BACKEND_URL and INGESTION_API_KEY must be set in frontend/.env.local." };
  }
  let response;
  try {
    response = await fetch(`${backendUrl}${path}`, {
      ...init,
      headers: { "x-ingestion-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, error: `Could not reach the backend at ${backendUrl}. Start it with "cd backend && npm run dev".` };
  }
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body, error: response.ok ? null : body.error || `HTTP ${response.status}` };
}

// Starts collection + analysis in the background; returns at once.
export async function runAiServices() {
  const result = await callBackend("/api/event-intel/run", { method: "POST" });
  if (result.status === 409) return { ok: false, alreadyRunning: true, error: result.error, job: result.body.job ?? null };
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, job: result.body.job };
}

// Polled while a run is in progress.
export async function getAiServicesStatus() {
  const result = await callBackend("/api/event-intel/status");
  if (!result.ok) return { ok: false, error: result.error };
  const { current, last, lastSuccess, schedule } = result.body;
  return { ok: true, current, last, lastSuccess, schedule };
}

// Called once a run has finished, so the pages show the new results.
export async function refreshNewsPages() {
  revalidatePath("/dashboard/medicine-impact/news");
  revalidatePath("/dashboard/medicine-impact/articles");
  revalidatePath("/dashboard/medicine-impact/events");
}
