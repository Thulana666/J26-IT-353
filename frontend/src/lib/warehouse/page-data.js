import { unstable_rethrow } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { warehouseApi } from "@/lib/warehouse/api";

// Helpers for warehouse pages (Server Components).

// Resolves to [data, null] or [null, errorMessage]; Next.js control-flow
// errors (redirects, dynamic rendering) are rethrown.
export async function safe(promise) {
  try {
    return [await promise, null];
  } catch (error) {
    unstable_rethrow(error);
    return [null, error.message];
  }
}

// Search params without empty values, e.g. for pagination links.
export function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => typeof value === "string" && value !== "")
  );
}

export async function getViewer() {
  const { user, profile } = await requireUser();
  return { user, profile, isAdmin: profile?.role === "admin" && profile?.status === "active" };
}

export function getWarehouses() {
  return warehouseApi("/warehouse/warehouses").then((body) => body.warehouses);
}

export function getMedicines() {
  return warehouseApi("/medicines", { query: { active: true } }).then((body) => body.medicines);
}
