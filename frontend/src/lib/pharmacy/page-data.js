import { cache } from "react";
import { unstable_rethrow } from "next/navigation";
import { pharmacyApi } from "@/lib/pharmacy/api";

// Helpers for pharmacy pages (Server Components).

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

// Role, pharmacies and toolbar counts; one request shared by layout and page.
export const getPharmacyContext = cache(() => safe(pharmacyApi("/pharmacy/context")));

// Search params without empty values.
export function cleanParams(params) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => typeof value === "string" && value !== ""));
}
