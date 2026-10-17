"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck, ScanLine } from "lucide-react";
import { lookupCodeAction, receiveShipmentAction, acceptHeldItemAction } from "@/app/dashboard/pharmacy/actions";
import { BarcodeInput } from "@/components/pharmacy/barcode-input";
import { DiscrepancyForm } from "@/components/pharmacy/discrepancy-form";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { ActionForm, FormMessage, TextField } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DISCREPANCY_STATUS, DISCREPANCY_TYPES, formatDate, itemState, packLabel, productLabel, unitLabel } from "@/lib/pharmacy/format";

// Receiving one shipment.
//
// Matching delivery: staff inspect the boxes against the order and the
// warehouse's shipment details, then click Confirm Receipt. No scanning; the
// database adds the shipped quantities and the warehouse's batch details.
//
// Disputed item: "Report discrepancy / Scan item" opens a scanner (USB reader
// or typed code / product name). The scanned item opens its Product Details
// page in this shipment's context, where the discrepancy is recorded. Unknown
// barcodes are recorded here as unknown items. With any report, only
// "Accept verified items" is possible: disputed items stay out of stock until
// the warehouse resolves them and staff accept the verified quantity.
export function ShipmentReceipt({ shipment, discrepancies }) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [lookupMessage, setLookupMessage] = useState(null);
  const [choice, setChoice] = useState(null);
  const [unknownCode, setUnknownCode] = useState(null);
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState(null);
  const [looking, startLookup] = useTransition();
  const [saving, startSaving] = useTransition();

  const inTransit = shipment.status === "in_transit";
  const reportsByItem = (itemId) => discrepancies.filter((d) => d.shipmentItemId === itemId);
  const disputedItems = shipment.items.filter((i) => reportsByItem(i.id).length > 0);
  const productHref = (productId, itemId) =>
    `/dashboard/pharmacy/inventory/${productId}?shipment=${shipment.id}${itemId ? `&item=${itemId}` : ""}`;

  function openProduct(product, code) {
    const matches = shipment.items.filter((i) => i.product?.id === product.id);
    const suffix = code ? `&code=${encodeURIComponent(code)}` : "";
    if (matches.length === 1) return router.push(productHref(product.id, matches[0].id) + suffix);
    if (matches.length > 1) return setChoice({ product, items: matches, code });
    // Known product that is not part of this shipment: an incorrect item.
    router.push(productHref(product.id, null) + suffix);
  }

  function onScan(code, medicineId) {
    setLookupMessage(null);
    setChoice(null);
    setUnknownCode(null);
    startLookup(async () => {
      const response = await lookupCodeAction(code, medicineId);
      if (!response.ok) return setLookupMessage({ tone: "red", text: response.error });
      const r = response.result;
      if (r.scannedBatchId) {
        const item = shipment.items.find((i) => i.batch?.id === r.scannedBatchId);
        if (item) return router.push(productHref(item.product.id, item.id) + `&code=${encodeURIComponent(code)}`);
      }
      if (r.matches?.length) {
        setChoice({ search: code, matches: r.matches });
        return setLookupMessage({ tone: "blue", text: `${r.matches.length} products match "${code}". Choose one.` });
      }
      // A typed product name is not a barcode: only scanned codes are kept.
      if (r.product) return openProduct(r.product, ["barcode", "pack_barcode", "batch_number", "warehouse_qr"].includes(r.match) ? code : null);
      setUnknownCode(code);
      setLookupMessage({ tone: "amber", text: `"${code}" does not match any known product. Record it below as an unknown item.` });
    });
  }

  function confirm(acceptPartial) {
    const question = acceptPartial
      ? `Accept the ${shipment.items.length - disputedItems.length} undisputed item(s) into stock? The ${disputedItems.length} disputed item(s) stay out of stock until the warehouse resolves them.`
      : `Confirm that all ${shipment.items.length} item(s) were physically checked and match the order and shipment details?`;
    if (!window.confirm(question)) return;
    setResult(null);
    startSaving(async () => {
      const response = await receiveShipmentAction(shipment.id, { acceptPartial, notes: notes || undefined });
      setResult(response);
      if (response.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {inTransit && (
        <div className="flex gap-3 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          <ClipboardCheck size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Physical inspection</p>
            <p>
              Open the delivered boxes and compare every item with the original order and the warehouse&apos;s shipment details below (product,
              batch number, expiry date, quantity). If everything is present and correct, click <strong>Confirm Receipt</strong> — no scanning is
              needed. If any item is missing, extra, damaged or incorrect, use <strong>Report discrepancy / Scan item</strong> for that item only.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Items: ordered vs shipped</CardTitle>
          <CardDescription>Batch details as provided by the warehouse. Quantities are warehouse packs.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Product · brand · manufacturer</TableHead>
                <TableHead>Batch (warehouse)</TableHead>
                <TableHead className="text-right">Ordered</TableHead>
                <TableHead className="text-right">Shipped</TableHead>
                <TableHead className="text-right">Accepted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipment.items.map((item) => {
                const [label, tone] = itemState(item);
                const reports = reportsByItem(item.id);
                return (
                  <TableRow key={item.id} className="align-top">
                    <TableCell className="pl-4">
                      <div className="font-medium">{productLabel(item.product)}</div>
                      <div className="text-xs text-muted-foreground">{[item.product?.brandName, item.product?.manufacturer].filter(Boolean).join(" · ") || "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        1 {packLabel(item.product, 1)} = {item.unitsPerPack} {unitLabel(item.product)}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-mono">{item.batch?.batchNumber}</div>
                      <div>Mfg {formatDate(item.batch?.manufacturingDate)}</div>
                      <div>Exp {formatDate(item.batch?.expiryDate)}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantityOrdered ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantityShipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{item.quantityAccepted ?? "—"}</TableCell>
                    <TableCell>
                      <ToneBadge tone={tone}>{label}</ToneBadge>
                      {reports.map((d) => (
                        <div key={d.id} className="mt-1 text-xs">
                          <span className="font-mono">{d.reportNumber}</span> {DISCREPANCY_TYPES[d.type]}{" "}
                          <StatusBadge map={DISCREPANCY_STATUS} value={d.status} />
                          {d.heldUnits > 0 && <span className="text-amber-800"> · {d.heldUnits} unit(s) held</span>}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="pr-4">
                      <Button variant="ghost" size="xs" nativeButton={false} render={<Link href={productHref(item.product.id, item.id)} />}>
                        Report issue
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {inTransit && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="receipt-notes">Receipt notes (optional)</Label>
              <Input id="receipt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. cartons sealed, cold box intact" />
            </div>
            {disputedItems.length > 0 || discrepancies.length > 0 ? (
              <p className="text-sm text-amber-900">
                This shipment has {discrepancies.length} discrepancy report(s), so it cannot be confirmed as fully correct. Accepting verified items adds
                only the {shipment.items.length - disputedItems.length} undisputed item(s); disputed items stay out of stock.
              </p>
            ) : null}
            <FormMessage state={result} />
            <div className="flex flex-wrap gap-2">
              {discrepancies.length === 0 ? (
                <Button onClick={() => confirm(false)} disabled={saving}>
                  {saving ? "Confirming…" : "Confirm Receipt"}
                </Button>
              ) : (
                <Button onClick={() => confirm(true)} disabled={saving}>
                  {saving ? "Recording…" : `Accept verified items (${shipment.items.length - disputedItems.length} of ${shipment.items.length})`}
                </Button>
              )}
              <Button variant="outline" onClick={() => setScanning((on) => !on)} aria-expanded={scanning}>
                <ScanLine size={14} />
                {scanning ? "Close scanner" : "Report discrepancy / Scan item"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!inTransit && result?.ok && <FormMessage state={result} />}

      {(scanning || !inTransit) && (
        <Card>
          <CardHeader>
            <CardTitle>{inTransit ? "Scan the disputed item" : "Report a problem found after receipt"}</CardTitle>
            <CardDescription>
              Scan the barcode of the specific item with a barcode reader, or type its barcode, batch number or name. Its product page opens with this
              shipment&apos;s details, where you record the discrepancy.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <BarcodeInput id="dispute-scan" label="Disputed item" onScan={(code) => onScan(code)} busy={looking} autoFocus={scanning} />
            {lookupMessage && (
              <p
                role="status"
                className={`rounded-lg border px-3 py-2 text-sm ${
                  { red: "border-red-200 bg-red-50 text-red-700", amber: "border-amber-200 bg-amber-50 text-amber-900", blue: "border-sky-200 bg-sky-50 text-sky-900" }[lookupMessage.tone]
                }`}
              >
                {lookupMessage.text}
              </p>
            )}
            {choice?.matches && (
              <div className="flex flex-wrap gap-2">
                {choice.matches.map((m) => (
                  <Button key={m.id} variant="outline" size="sm" onClick={() => onScan("", m.id)}>
                    {productLabel(m)}
                    {m.brandName ? ` · ${m.brandName}` : ""}
                  </Button>
                ))}
              </div>
            )}
            {choice?.items && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>Which batch is on the pack?</span>
                {choice.items.map((i) => (
                  <Button
                    key={i.id}
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(productHref(choice.product.id, i.id) + (choice.code ? `&code=${encodeURIComponent(choice.code)}` : ""))}
                  >
                    {i.batch?.batchNumber} (exp {formatDate(i.batch?.expiryDate)})
                  </Button>
                ))}
              </div>
            )}
            {unknownCode && (
              <div className="rounded-lg border p-3">
                <p className="mb-2 text-sm font-medium">Unknown item — no product or batch details are assumed</p>
                <DiscrepancyForm shipmentId={shipment.id} barcode={unknownCode} />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <HeldItems shipment={shipment} discrepancies={discrepancies} />
    </div>
  );
}

// Disputed items held out of stock after the receipt: accept the verified
// quantity once the warehouse has resolved every report of the item.
function HeldItems({ shipment, discrepancies }) {
  if (shipment.status === "in_transit") return null;
  const held = shipment.items.filter((i) => i.verificationStatus === "discrepancy" && i.quantityAccepted === null);
  if (held.length === 0) return null;
  return (
    <Card className="border-amber-200">
      <CardHeader>
        <CardTitle>Held items</CardTitle>
        <CardDescription>
          Disputed items are not in stock. When the warehouse has resolved all reports of an item, enter the packs you verified as correct (0 if none);
          only those are added.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {held.map((item) => {
          const reports = discrepancies.filter((d) => d.shipmentItemId === item.id);
          const open = reports.filter((d) => d.status !== "resolved");
          return (
            <div key={item.id} className="grid gap-3 rounded-lg border p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="text-sm">
                <p className="font-medium">
                  {productLabel(item.product)} · <span className="font-mono">{item.batch?.batchNumber}</span>
                </p>
                <p className="text-muted-foreground">{item.quantityShipped} pack(s) shipped</p>
                <ul className="mt-1 text-xs">
                  {reports.map((d) => (
                    <li key={d.id}>
                      <span className="font-mono">{d.reportNumber}</span> {DISCREPANCY_TYPES[d.type]} · expected {d.expectedQuantity}, observed {d.actualQuantity ?? "—"}{" "}
                      <StatusBadge map={DISCREPANCY_STATUS} value={d.status} />
                      {d.resolutionNotes && <span className="text-emerald-700"> · {d.resolutionNotes}</span>}
                    </li>
                  ))}
                </ul>
              </div>
              {open.length > 0 ? (
                <p className="text-sm text-amber-900">
                  Waiting for the warehouse to resolve {open.map((d) => d.reportNumber).join(", ")}. The item stays out of stock until then.
                </p>
              ) : (
                <ActionForm action={acceptHeldItemAction} submitLabel="Accept verified packs" pendingLabel="Accepting…">
                  <input type="hidden" name="shipmentId" value={shipment.id} />
                  <input type="hidden" name="itemId" value={item.id} />
                  <TextField id={`qty-${item.id}`} name="quantity" label={`Verified packs (0–${item.quantityShipped})`} type="number" min={0} max={item.quantityShipped} required />
                  <TextField id={`notes-${item.id}`} name="notes" label="Notes (optional)" />
                </ActionForm>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
