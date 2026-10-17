"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createOrderAction, rejectRecommendationAction } from "@/app/dashboard/pharmacy/actions";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { FormMessage, selectClass } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RISK, formatNum, packLabel, productLabel, unitLabel } from "@/lib/pharmacy/format";

// Builds an order for the warehouse. Lines start from the pending reorder
// recommendations (Q* in warehouse packs); staff accept a line as is, change
// its quantity (recorded as "edited") or reject it with a reason. Products
// without a recommendation can be added. Quantities are whole packs.
export function OrderBuilder({ recommendations, products }) {
  const router = useRouter();
  const [lines, setLines] = useState(() =>
    recommendations
      .filter((r) => r.recommendedPacks > 0)
      // Products at or below their reorder point are pre-selected; the rest can wait for the next review.
      .sort((a, b) => Number(b.needsReorder) - Number(a.needsReorder))
      .map((r) => ({ key: r.id, product: r.product, quantity: String(r.recommendedPacks), include: r.needsReorder, rec: r }))
  );
  const [adding, setAdding] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState(null);
  const [pending, startTransition] = useTransition();

  const inList = new Set(lines.map((l) => l.product.id));
  const update = (key, changes) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  function addProduct() {
    const product = products.find((p) => p.id === adding);
    if (!product) return;
    const rec = recommendations.find((r) => r.medicineId === product.id);
    setLines((current) => [...current, { key: crypto.randomUUID(), product, quantity: String(rec?.recommendedPacks || 1), include: true, rec: rec ?? null }]);
    setAdding("");
  }

  function reject(line) {
    const reason = window.prompt(`Why reject the recommendation for ${productLabel(line.product)}?`, "Enough stock on the shelf");
    if (reason === null) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("recommendationId", line.rec.id);
      formData.set("notes", reason);
      const response = await rejectRecommendationAction(null, formData);
      setResult(response);
      if (response.ok) {
        setLines((current) => current.filter((l) => l.key !== line.key));
        router.refresh();
      }
    });
  }

  const chosen = lines.filter((l) => l.include);
  const invalid = chosen.some((l) => !/^\d+$/.test(l.quantity) || Number(l.quantity) < 1);

  function submit() {
    setResult(null);
    startTransition(async () => {
      const response = await createOrderAction({
        items: chosen.map((l) => ({ medicineId: l.product.id, quantity: Number(l.quantity), recommendationId: l.rec?.status === "pending" ? l.rec.id : undefined })),
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
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recommended orders right now. Add products below to order manually.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Forecast/day</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead className="text-right">Recommended Q*</TableHead>
              <TableHead className="w-28">Order (packs)</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const edited = l.rec && Number(l.quantity) !== l.rec.recommendedPacks;
              return (
                <TableRow key={l.key} className="align-top">
                  <TableCell>
                    <input type="checkbox" checked={l.include} onChange={(e) => update(l.key, { include: e.target.checked })} aria-label={`Include ${productLabel(l.product)}`} className="mt-2 size-4" />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{productLabel(l.product)}</div>
                    <div className="text-xs text-muted-foreground">
                      1 {packLabel(l.product, 1)} = {l.product.unitsPerPack} {unitLabel(l.product)}
                    </div>
                    {l.rec && (
                      <details className="mt-1 max-w-md text-xs text-muted-foreground">
                        <summary className="cursor-pointer">Why this quantity?</summary>
                        <p className="mt-1 whitespace-normal">{l.rec.explanation}</p>
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.rec ? formatNum(l.rec.onHandUsable - l.rec.reserved) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.rec ? formatNum(l.rec.forecastDailyDemand) : "—"}</TableCell>
                  <TableCell>
                    {l.rec ? <StatusBadge map={RISK} value={l.rec.stockoutRisk} /> : "—"}
                    {l.rec && (l.rec.needsReorder ? <ToneBadge tone="red" className="mt-1">Reorder now</ToneBadge> : <ToneBadge className="mt-1">Next review</ToneBadge>)}
                    {l.rec?.isProvisional && <ToneBadge tone="amber" className="mt-1">Provisional</ToneBadge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.rec ? `${l.rec.recommendedPacks} ${packLabel(l.product, l.rec.recommendedPacks)}` : "manual"}</TableCell>
                  <TableCell>
                    <Input type="number" min={1} step={1} value={l.quantity} aria-label={`Packs of ${productLabel(l.product)}`} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                    {edited && <ToneBadge tone="amber" className="mt-1">Edited</ToneBadge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {l.rec?.status === "pending" && (
                        <Button variant="outline" size="xs" onClick={() => reject(l)} disabled={pending}>
                          Reject
                        </Button>
                      )}
                      {!l.rec && (
                        <Button variant="ghost" size="icon-xs" aria-label="Remove" onClick={() => setLines((c) => c.filter((x) => x.key !== l.key))}>
                          <Trash2 size={12} />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-64 flex-col gap-1.5">
          <Label htmlFor="add-product">Add a product</Label>
          <select id="add-product" className={selectClass} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose…</option>
            {products
              .filter((p) => !inList.has(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {productLabel(p)} ({p.packUnit} of {p.unitsPerPack})
                </option>
              ))}
          </select>
        </div>
        <Button variant="outline" onClick={addProduct} disabled={!adding}>
          Add
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="order-notes">Notes for the warehouse (optional)</Label>
        <Input id="order-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <FormMessage state={result} />
      <div>
        <Button onClick={submit} disabled={pending || chosen.length === 0 || invalid}>
          {pending ? "Sending…" : `Send order (${chosen.length} product${chosen.length === 1 ? "" : "s"})`}
        </Button>
      </div>
    </div>
  );
}
