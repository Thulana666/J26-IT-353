"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createOrderAction, rejectRecommendationAction, warehouseStockAction } from "@/app/dashboard/pharmacy/actions";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { FormMessage, selectClass } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RISK, formatDateTime, formatNum, packLabel, productLabel, unitLabel } from "@/lib/pharmacy/format";

// Packs of a product the warehouse can send; null when unknown (the check
// failed or the pharmacy has no supplying warehouse).
const packsAt = (info, product) => (info?.warehouse ? (info.stock[product.id] ?? 0) : null);

// Builds an order for the warehouse. Lines start from the pending reorder
// recommendations (Q* in warehouse packs); staff accept a line as is, change
// its quantity (recorded as "edited") or reject it with a reason. Products
// without a recommendation can be added. Quantities are whole packs.
//
// warehouseStock: GET /pharmacy/orders/warehouse-stock, re-checked every 30 s
// while the page is visible. Products the warehouse does not have cannot be
// ordered, and no line may ask for more than it has; the backend checks again.
export function OrderBuilder({ recommendations, products, warehouseStock }) {
  const router = useRouter();
  const [lines, setLines] = useState(() =>
    recommendations
      .filter((r) => r.recommendedPacks > 0)
      // Products at or below their reorder point are pre-selected; the rest can wait for the next review.
      .sort((a, b) => Number(b.needsReorder) - Number(a.needsReorder))
      .map((r) => ({
        key: r.id,
        product: r.product,
        quantity: String(r.recommendedPacks),
        include: r.needsReorder && packsAt(warehouseStock, r.product) !== 0,
        rec: r,
      }))
  );
  const [adding, setAdding] = useState("");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState(null);
  const [pending, startTransition] = useTransition();
  const [rechecked, setRechecked] = useState(null);
  const [checking, startChecking] = useTransition();

  // The newest of the page's stock and a re-check.
  const stockInfo = rechecked && (!warehouseStock || rechecked.checkedAt > warehouseStock.checkedAt) ? rechecked : warehouseStock;
  const warehousePacks = (product) => packsAt(stockInfo, product);

  const recheck = useCallback(() => {
    startChecking(async () => {
      const response = await warehouseStockAction();
      if (response.ok) setRechecked(response.result);
    });
  }, []);

  // Warehouse stock changes in the warehouse application: re-check while visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") recheck();
    }, 30_000);
    return () => clearInterval(timer);
  }, [recheck]);

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

  const outOfStock = (l) => warehousePacks(l.product) === 0;
  const overStock = (l) => {
    const packs = warehousePacks(l.product);
    return packs !== null && packs > 0 && Number(l.quantity) > packs;
  };
  const chosen = lines.filter((l) => l.include && !outOfStock(l));
  const invalid = chosen.some((l) => !/^\d+$/.test(l.quantity) || Number(l.quantity) < 1);
  const short = chosen.filter(overStock);
  const noWarehouse = Boolean(stockInfo) && !stockInfo.warehouse;

  function submit() {
    setResult(null);
    if (short.length > 0) {
      setResult({ ok: false, error: `Not enough stock at the warehouse for ${short.map((l) => productLabel(l.product)).join(", ")}.` });
      return;
    }
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
      } else {
        // The warehouse's stock may have changed since the last check.
        recheck();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {!stockInfo ? (
          <span className="text-amber-800">Warehouse stock could not be checked. It is checked again when you send the order.</span>
        ) : noWarehouse ? (
          <span className="text-red-700">This pharmacy has no supplying warehouse, so orders cannot be sent. An admin sets it in Settings.</span>
        ) : (
          <span className="text-muted-foreground">
            Warehouse stock at {stockInfo.warehouse.name}, checked {formatDateTime(stockInfo.checkedAt)}. Only batches with at least{" "}
            {stockInfo.minShelfDays} days of shelf life count: the warehouse does not send shorter-dated stock to pharmacies.
          </span>
        )}
        <Button variant="outline" size="xs" onClick={recheck} disabled={checking}>
          {checking ? "Checking…" : "Re-check"}
        </Button>
      </div>
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No recommended orders right now. Add products below to order manually.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Available here</TableHead>
              <TableHead className="text-right">Warehouse stock</TableHead>
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
              const packs = warehousePacks(l.product);
              const out = packs === 0;
              const over = overStock(l);
              return (
                <TableRow key={l.key} className="align-top">
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={l.include && !out}
                      disabled={out}
                      onChange={(e) => update(l.key, { include: e.target.checked })}
                      aria-label={`Include ${productLabel(l.product)}`}
                      className="mt-2 size-4 disabled:cursor-not-allowed"
                    />
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
                  <TableCell className="text-right tabular-nums">
                    {l.rec ? (
                      <>
                        {formatNum(l.rec.onHandUsable - l.rec.reserved)} <span className="text-xs text-muted-foreground">{unitLabel(l.product)}</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {packs === null ? (
                      <span className="text-muted-foreground" title="Warehouse stock could not be checked">
                        —
                      </span>
                    ) : out ? (
                      <ToneBadge tone="red">Out of Stock at Warehouse</ToneBadge>
                    ) : (
                      <span className="tabular-nums">
                        {formatNum(packs)} <span className="text-xs text-muted-foreground">{packLabel(l.product, packs)}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.rec ? formatNum(l.rec.forecastDailyDemand) : "—"}</TableCell>
                  <TableCell>
                    {l.rec ? <StatusBadge map={RISK} value={l.rec.stockoutRisk} /> : "—"}
                    {l.rec && (l.rec.needsReorder ? <ToneBadge tone="red" className="mt-1">Reorder now</ToneBadge> : <ToneBadge className="mt-1">Next review</ToneBadge>)}
                    {l.rec?.isProvisional && <ToneBadge tone="amber" className="mt-1">Provisional</ToneBadge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.rec ? `${l.rec.recommendedPacks} ${packLabel(l.product, l.rec.recommendedPacks)}` : "manual"}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={1}
                      max={packs ?? undefined}
                      step={1}
                      value={l.quantity}
                      disabled={out}
                      aria-invalid={over || undefined}
                      aria-label={`Packs of ${productLabel(l.product)}`}
                      onChange={(e) => update(l.key, { quantity: e.target.value })}
                    />
                    {over && (
                      <p className="mt-1 text-xs whitespace-normal text-red-700">
                        Only {formatNum(packs)} {packLabel(l.product, packs)} at the warehouse
                      </p>
                    )}
                    {edited && !out && <ToneBadge tone="amber" className="mt-1">Edited</ToneBadge>}
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
              .map((p) => {
                const packs = warehousePacks(p);
                return (
                  <option key={p.id} value={p.id} disabled={packs === 0}>
                    {productLabel(p)} ({p.packUnit} of {p.unitsPerPack})
                    {packs === null ? "" : packs === 0 ? " — out of stock at warehouse" : ` — ${formatNum(packs)} at warehouse`}
                  </option>
                );
              })}
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
      {short.length > 0 && (
        <p role="alert" className="text-sm text-red-700">
          The warehouse does not have enough stock for {short.map((l) => productLabel(l.product)).join(", ")}. Reduce the quantity to send the order.
        </p>
      )}
      <FormMessage state={result} />
      <div>
        <Button onClick={submit} disabled={pending || chosen.length === 0 || invalid || short.length > 0 || noWarehouse}>
          {pending ? "Sending…" : `Send order (${chosen.length} product${chosen.length === 1 ? "" : "s"})`}
        </Button>
      </div>
    </div>
  );
}
