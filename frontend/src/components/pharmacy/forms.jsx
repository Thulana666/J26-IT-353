"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fieldLabel } from "@/lib/pharmacy/format";
import { cn } from "@/lib/utils";

export const selectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";
const textareaClass =
  "min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function FormMessage({ state }) {
  if (!state) return null;
  const fields = Object.entries(state.fields ?? {});
  if (state.ok === false) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
        {fields.length > 0 && (
          <ul className="mt-1 list-disc pl-5">
            {fields.map(([field, message]) => (
              <li key={field}>
                {fieldLabel(field)} {message}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (state.ok && state.message) {
    return (
      <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        {state.message}
      </p>
    );
  }
  return null;
}

// A form bound to a server action returning { ok, message } | { ok: false, error, fields }.
// Submits through onSubmit so React keeps the inputs when the backend rejects them.
// secondary: { name, value, label, disabled? } adds a second submit button
// (plain data, so Server Components can pass it).
export function ActionForm({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  variant,
  size,
  className,
  resetOnSuccess = true,
  confirm,
  children,
  secondary,
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  function handleSubmit(event) {
    event.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const formData = new FormData(event.currentTarget);
    const submitter = event.nativeEvent.submitter;
    if (submitter?.name) formData.set(submitter.name, submitter.value);
    startTransition(() => formAction(formData));
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className={cn("flex flex-col gap-3", className)}>
      {children}
      <FormMessage state={state} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant={variant} size={size} disabled={pending}>
          {pending ? pendingLabel : submitLabel}
        </Button>
        {secondary && (
          <button
            type="submit"
            name={secondary.name}
            value={secondary.value}
            disabled={pending || secondary.disabled}
            className="text-xs text-muted-foreground underline disabled:opacity-40"
          >
            {secondary.label}
          </button>
        )}
      </div>
    </form>
  );
}

// One-button form for row actions (acknowledge, approve...). Shows errors inline.
export function InlineAction({ action, fields, label, pendingLabel, variant = "outline", size = "sm", confirm }) {
  const [state, formAction, pending] = useActionState(action, null);
  function handleSubmit(event) {
    event.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }
  return (
    <form onSubmit={handleSubmit} className="inline-flex flex-col items-start gap-1">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? (pendingLabel ?? `${label}…`) : label}
      </Button>
      {state?.ok === false && <span className="max-w-56 text-xs text-red-700">{state.error}</span>}
    </form>
  );
}

export function Field({ id, label, hint, className, children }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function TextField({ id, name = id, label, hint, className, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <Input id={id} name={name} {...props} />
    </Field>
  );
}

// options: [{ value, label }]; `placeholder` adds an empty first option.
export function SelectField({ id, name = id, label, hint, className, options, placeholder, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <select id={id} name={name} className={selectClass} {...props}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextAreaField({ id, name = id, label, hint, className, ...props }) {
  return (
    <Field id={id} label={label} hint={hint} className={className}>
      <textarea id={id} name={name} className={textareaClass} {...props} />
    </Field>
  );
}
