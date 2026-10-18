"use client";

import { startTransition, useActionState, useState } from "react";
import { reportIssueAction } from "@/app/driver/actions";
import { FormMessage } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { ISSUE_TYPES } from "@/lib/cold-chain/format";

const fieldClass =
  "w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

// REPORT AN ISSUE: type + description. The truck sensor's newest values and
// the time are attached by the backend.
export function ReportIssue({ shipmentId }) {
  const [open, setOpen] = useState(false);
  // Closing the form after a successful report also clears it (it unmounts).
  const [state, formAction, pending] = useActionState(async (previous, formData) => {
    const result = await reportIssueAction(previous, formData);
    if (result.ok) setOpen(false);
    return result;
  }, null);

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {state?.ok && <FormMessage state={state} />}
        <Button type="button" variant="outline" size="lg" className="h-12 w-full text-base" onClick={() => setOpen(true)}>
          REPORT AN ISSUE
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border p-4">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <p className="text-base font-medium">Report an issue</p>
      <label className="flex flex-col gap-1.5 text-sm">
        Issue type
        <select name="issueType" required defaultValue="" className={`${fieldClass} h-12`}>
          <option value="" disabled>
            Choose…
          </option>
          {Object.entries(ISSUE_TYPES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Description
        <textarea name="description" required minLength={3} maxLength={1000} rows={3} placeholder="What happened?" className={`${fieldClass} min-h-24 py-2`} />
      </label>
      <p className="text-xs text-muted-foreground">The truck sensor&apos;s latest location, temperature and humidity are attached automatically.</p>
      <FormMessage state={state?.ok ? null : state} />
      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="outline" size="lg" className="h-12 text-base" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="h-12 text-base" disabled={pending}>
          {pending ? "Sending…" : "Send report"}
        </Button>
      </div>
    </form>
  );
}
