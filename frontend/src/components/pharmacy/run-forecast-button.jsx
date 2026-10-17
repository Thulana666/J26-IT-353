"use client";

import { runForecastAction } from "@/app/dashboard/pharmacy/actions";
import { ActionForm } from "@/components/pharmacy/forms";

// Runs forecasts, recommendations and alerts for the current pharmacy.
export function RunForecastButton({ variant = "default", label = "Run forecast now" }) {
  return (
    <ActionForm
      action={runForecastAction}
      submitLabel={label}
      pendingLabel="Training models…"
      variant={variant}
      resetOnSuccess={false}
      className="items-end gap-2"
    />
  );
}
