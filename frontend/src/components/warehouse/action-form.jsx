"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { fieldLabel } from "@/lib/warehouse/format";
import styles from "./warehouse.module.css";

// A form bound to a warehouse server action, which returns
// { ok: true, message } or { ok: false, error, fields }.
// Submits through onSubmit (not the form `action` prop) so React does not
// clear the inputs when the backend rejects them; it resets after success.
export function ActionForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  variant,
  className,
  resetOnSuccess = true,
  children,
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const fieldErrors = Object.entries(state?.fields ?? {});
  return (
    <form ref={formRef} onSubmit={handleSubmit} className={className ?? styles.form}>
      {children}
      {state?.ok === false && (
        <div role="alert" className={styles.formError}>
          {state.error}
          {fieldErrors.length > 0 && (
            <ul>
              {fieldErrors.map(([field, message]) => (
                <li key={field}>
                  {fieldLabel(field)} {message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state?.ok && state.message && (
        <p role="status" className={styles.formSuccess}>
          {state.message}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
