"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { reportDiscrepancyAction } from "@/app/dashboard/pharmacy/actions";
import { FormMessage, selectClass } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DISCREPANCY_TYPES, REPORT_TYPES } from "@/lib/pharmacy/format";

const newKey = () => crypto.randomUUID();

// Records one discrepancy for a disputed shipment item, or for an item that is
// not part of the shipment (known product or unknown barcode). The expected
// quantity of a shipment item is fixed by the shipment (shown read-only; the
// server uses its own value). Each new report gets a new request id, so a
// double click or retry cannot create a duplicate.
//
// item: shipment item ({ id, quantityShipped, packUnit }) or null.
// medicineId: product of an unexpected item (null for an unknown barcode).
export function DiscrepancyForm({ shipmentId, item = null, medicineId = null, barcode = "", packUnit = "pack", backHref }) {
  const router = useRouter();
  const types = item ? Object.keys(REPORT_TYPES) : ["incorrect_item", "incorrect_batch", "excess", "other"];
  const [type, setType] = useState(types[0]);
  const [observed, setObserved] = useState("");
  const [notes, setNotes] = useState("");
  const [code, setCode] = useState(barcode);
  const [requestId, setRequestId] = useState(newKey);
  const [result, setResult] = useState(null);
  const [pending, startTransition] = useTransition();

  const observedHint = item ? REPORT_TYPES[type]?.observed : "Packs of this item that were delivered";
  const unknown = !item && !medicineId;

  function submit(event) {
    event.preventDefault();
    setResult(null);
    startTransition(async () => {
      const response = await reportDiscrepancyAction({
        clientRequestId: requestId,
        shipmentId,
        shipmentItemId: item?.id,
        medicineId: medicineId ?? undefined,
        type,
        observedQuantity: observed === "" ? undefined : observed,
        notes: notes || undefined,
        barcode: code || undefined,
      });
      setResult(response);
      if (response.ok) {
        // The next report is a new one.
        setRequestId(newKey());
        setObserved("");
        setNotes("");
        router.refresh();
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="disc-type">Discrepancy type</Label>
          <select id="disc-type" className={selectClass} value={type} onChange={(e) => setType(e.target.value)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {REPORT_TYPES[t]?.label ?? DISCREPANCY_TYPES[t]}
              </option>
            ))}
          </select>
        </div>
        {item && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="disc-expected">Expected (from the shipment)</Label>
            <Input id="disc-expected" value={`${item.quantityShipped} ${packUnit}(s)`} readOnly disabled />
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="disc-observed">Observed quantity ({packUnit}s)</Label>
          <Input id="disc-observed" type="number" min={0} step={1} required value={observed} onChange={(e) => setObserved(e.target.value)} />
          <span className="text-xs text-muted-foreground">{observedHint}</span>
        </div>
        {!item && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="disc-barcode">Scanned barcode</Label>
            <Input id="disc-barcode" value={code} onChange={(e) => setCode(e.target.value)} placeholder="As printed on the pack" />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="disc-notes">Notes{unknown ? " (describe the item)" : ""}</Label>
        <textarea
          id="disc-notes"
          className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={notes}
          required={unknown && !code}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={unknown ? "Label text, packaging, what is inside…" : "What did you find? e.g. carton crushed, foil broken"}
        />
      </div>
      <FormMessage state={result} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Recording…" : "Record discrepancy report"}
        </Button>
        {backHref && (
          <Button variant="outline" nativeButton={false} render={<Link href={backHref} />}>
            Back to the shipment
          </Button>
        )}
      </div>
    </form>
  );
}
