"use client";

import { startTransition, useActionState, useState } from "react";
import Link from "next/link";
import { confirmDeliveryAction } from "@/app/driver/actions";
import { FormMessage } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";

// MARK AS DELIVERED with an explicit confirmation step. The backend checks
// that this driver is assigned to the delivery and that it is in transit.
export function ConfirmDelivery({ shipmentId, pharmacyName }) {
  const [state, formAction, pending] = useActionState(confirmDeliveryAction, null);
  const [confirming, setConfirming] = useState(false);

  if (state?.ok) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
        <p className="text-lg font-semibold text-emerald-400">Delivery completed successfully.</p>
        <Button nativeButton={false} render={<Link href="/driver/dashboard" />} size="lg" variant="outline" className="h-12 w-full text-base">
          Back to my deliveries
        </Button>
      </div>
    );
  }

  if (!confirming) {
    return (
      <Button type="button" size="lg" className="h-14 w-full text-base font-semibold" onClick={() => setConfirming(true)}>
        MARK AS DELIVERED
      </Button>
    );
  }

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border p-4">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <p className="text-base font-medium">Confirm that this shipment has been delivered to the pharmacy?</p>
      {pharmacyName && <p className="text-sm text-muted-foreground">{pharmacyName}</p>}
      <label className="flex flex-col gap-1.5 text-sm">
        Note (optional)
        <textarea
          name="notes"
          maxLength={1000}
          rows={2}
          placeholder="e.g. handed to the pharmacist, boxes intact"
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <FormMessage state={state} />
      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="outline" size="lg" className="h-12 text-base" disabled={pending} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="h-12 text-base font-semibold" disabled={pending}>
          {pending ? "Confirming…" : "Confirm Delivery"}
        </Button>
      </div>
    </form>
  );
}
