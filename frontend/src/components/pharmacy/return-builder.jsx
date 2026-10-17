"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createReturnAction, lookupCodeAction } from "@/app/dashboard/pharmacy/actions";
import { BarcodeInput } from "@/components/pharmacy/barcode-input";
import { StatusBadge } from "@/components/pharmacy/badges";
import { FormMessage, selectClass } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EXPIRY_STATUS, RETURN_REASONS, formatDate, productLabel, unitLabel } from "@/lib/pharmacy/format";

const suggestedReason = (batch) =>
  batch.expiryStatus === "expired" ? "expired" : batch.batchStatus === "recalled" ? "recalled" : batch.expiryStatus === "ok" ? "overstock" : "near_expiry";

// Builds a return request. Only unreserved stock can be returned; the
// requested quantity is held (not sellable) until the warehouse receives
// or rejects it.
export function ReturnBuilder({ eligible }) {
  const router = useRouter();
  const [lines, setLines] = useState([]);
  const [picked, setPicked] = useState("");
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState(null);
  const [result, setResult] = useState(null);
  const [looking, startLookup] = useTransition();
  const [saving, startSaving] = useTransition();

  function add(batch) {
    if (lines.some((l) => l.batch.inventoryId === batch.inventoryId)) {
      return setNotice(`Batch ${batch.batchNumber} is already in the return.`);
    }
    setLines((current) => [...current, { batch, quantity: String(batch.quantityAvailable), reason: suggestedReason(batch), notes: "" }]);
    setNotice(null);
  }

  function onScan(code) {
    startLookup(async () => {
      const response = await lookupCodeAction(code);
      if (!response.ok) return setNotice(response.error);
      const r = response.result;
      const candidates = (r.batches ?? []).filter((b) => b.quantityAvailable > 0);
      const batch = candidates.find((b) => b.batchId === r.scannedBatchId) ?? (candidates.length === 1 ? candidates[0] : null);
      if (batch) return add(batch);
      setNotice(candidates.length > 1 ? `Several batches of ${productLabel(r.product)}: pick one from the list below.` : `No returnable stock for "${code}".`);
    });
  }

  const update = (id, changes) => setLines((current) => current.map((l) => (l.batch.inventoryId === id ? { ...l, ...changes } : l)));
  const invalid = lines.some((l) => !/^\d+$/.test(l.quantity) || Number(l.quantity) < 1 || Number(l.quantity) > l.batch.quantityAvailable);

  function submit() {
    setResult(null);
    startSaving(async () => {
      const response = await createReturnAction({
        items: lines.map((l) => ({ inventoryId: l.batch.inventoryId, quantity: Number(l.quantity), reason: l.reason, notes: l.notes || undefined })),
        notes: notes || undefined,
      });
      setResult(response);
      if (response.ok) {
        setLines([]);
        setNotes("");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <BarcodeInput id="return-scan" label="Scan or search an item" onScan={onScan} busy={looking} disabled={saving} autoFocus={false} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pick-batch">Or pick returnable stock</Label>
          <div className="flex gap-2">
            <select id="pick-batch" className={selectClass} value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Choose a batch…</option>
              {eligible.map((b) => (
                <option key={b.inventoryId} value={b.inventoryId}>
                  {productLabel(b.product)} · {b.batchNumber} · {b.quantityAvailable} {unitLabel(b.product)} · exp {formatDate(b.expiryDate)}
                  {b.expiryStatus === "expired" ? " · EXPIRED" : ""}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              disabled={!picked}
              onClick={() => {
                add(eligible.find((b) => b.inventoryId === picked));
                setPicked("");
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
      {notice && <p className="text-sm text-amber-800">{notice}</p>}

      {lines.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead className="w-28">Quantity</TableHead>
              <TableHead className="w-44">Reason</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => (
              <TableRow key={l.batch.inventoryId} className="align-top">
                <TableCell>
                  <div className="font-medium">{productLabel(l.batch.product)}</div>
                  <div className="font-mono text-xs">{l.batch.batchNumber}</div>
                </TableCell>
                <TableCell className="text-xs">
                  {formatDate(l.batch.expiryDate)} <StatusBadge map={EXPIRY_STATUS} value={l.batch.expiryStatus} />
                </TableCell>
                <TableCell>
                  <Input type="number" min={1} max={l.batch.quantityAvailable} value={l.quantity} aria-label="Quantity" onChange={(e) => update(l.batch.inventoryId, { quantity: e.target.value })} />
                  <span className="text-xs text-muted-foreground">
                    of {l.batch.quantityAvailable} {unitLabel(l.batch.product)}
                  </span>
                </TableCell>
                <TableCell>
                  <select className={selectClass} value={l.reason} aria-label="Reason" onChange={(e) => update(l.batch.inventoryId, { reason: e.target.value })}>
                    {Object.entries(RETURN_REASONS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </TableCell>
                <TableCell>
                  <Input value={l.notes} aria-label="Notes" onChange={(e) => update(l.batch.inventoryId, { notes: e.target.value })} />
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => setLines((c) => c.filter((x) => x !== l))}>
                    <Trash2 size={14} />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="return-notes">Notes for the warehouse (optional)</Label>
        <Input id="return-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <FormMessage state={result} />
      <div>
        <Button onClick={submit} disabled={saving || lines.length === 0 || invalid}>
          {saving ? "Sending…" : "Send return request"}
        </Button>
      </div>
    </div>
  );
}
