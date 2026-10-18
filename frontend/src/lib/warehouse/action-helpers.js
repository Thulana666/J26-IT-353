import { revalidatePath } from "next/cache";
import { WarehouseApiError } from "@/lib/warehouse/api";

// Helpers shared by the warehouse server actions (server-only).

export function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function checked(formData, key) {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

// Backend errors become { ok: false, ... } for <ActionForm>; anything else
// (a bug, a Next.js redirect) is rethrown.
export function failure(error) {
  if (!(error instanceof WarehouseApiError)) throw error;
  return { ok: false, error: error.message, fields: error.details?.fields ?? null };
}

export function refreshWarehouse() {
  revalidatePath("/dashboard/warehouse", "layout");
}

export const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
