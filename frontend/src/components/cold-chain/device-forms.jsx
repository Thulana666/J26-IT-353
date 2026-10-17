"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { registerDeviceAction, rotateDeviceKeyAction } from "@/app/dashboard/cold-chain/actions";
import { FormMessage, SelectField, TextField } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";

// Shows a newly issued device key once. The backend stores only its hash, and
// the key lives only in this component's state, so leaving or reloading the
// page drops it.
export function KeyReveal({ deviceCode, deviceKey, onDone }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(deviceKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <p className="font-medium">Key for {deviceCode}: copy it now, it is shown only once</p>
      <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs select-all">{deviceKey}</code>
      <p className="text-xs text-muted-foreground">
        Put it in the device firmware as the <code>X-Device-Key</code> header, with <code>X-Device-Id: {deviceCode}</code>. Anyone
        with the key can send readings as this device: keep it out of source control and rotate it if it leaks.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? "Copied" : "Copy key"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          I have stored the key
        </Button>
      </div>
    </div>
  );
}

// Admin form: register an ESP32 logger or a simulator.
export function RegisterDeviceForm() {
  const [state, formAction, pending] = useActionState(registerDeviceAction, null);
  const [doneKey, setDoneKey] = useState(null);
  const formRef = useRef(null);

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  function handleSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const showKey = state?.ok && state.deviceKey && state.deviceKey !== doneKey;
  return (
    <div className="flex flex-col gap-3">
      <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="grid gap-4 md:grid-cols-3">
          <TextField id="deviceCode" label="Device code" required placeholder="ESP32-001" hint="3-40 letters, digits, - or _; sent as X-Device-Id." />
          <TextField id="name" label="Name" placeholder="Reefer truck 1 logger" />
          <SelectField
            id="deviceType"
            label="Type"
            defaultValue="esp32"
            options={[
              { value: "esp32", label: "ESP32 sensor logger" },
              { value: "simulator", label: "Simulator (test data only)" },
            ]}
          />
        </div>
        <TextField id="notes" label="Notes" placeholder="Sensors: SHT31, NEO-6M, MPU6050" />
        {!showKey && <FormMessage state={state?.ok ? null : state} />}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Registering…" : "Register device"}
          </Button>
        </div>
      </form>
      {showKey && <KeyReveal deviceCode={state.deviceCode} deviceKey={state.deviceKey} onDone={() => setDoneKey(state.deviceKey)} />}
    </div>
  );
}

// Admin row action: issue a new key (the old one stops working at once).
export function RotateKeyButton({ deviceId, deviceCode }) {
  const [state, formAction, pending] = useActionState(rotateDeviceKeyAction, null);
  const [doneKey, setDoneKey] = useState(null);

  function handleSubmit(event) {
    event.preventDefault();
    if (!window.confirm(`Issue a new key for ${deviceCode}? The current key stops working at once.`)) return;
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  const showKey = state?.ok && state.deviceKey && state.deviceKey !== doneKey;
  return (
    <div className="flex flex-col items-start gap-2">
      <form onSubmit={handleSubmit}>
        <input type="hidden" name="deviceId" value={deviceId} />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Rotating…" : "Rotate key"}
        </Button>
      </form>
      {state?.ok === false && <span className="text-xs text-destructive">{state.error}</span>}
      {showKey && <KeyReveal deviceCode={state.deviceCode} deviceKey={state.deviceKey} onDone={() => setDoneKey(state.deviceKey)} />}
    </div>
  );
}
