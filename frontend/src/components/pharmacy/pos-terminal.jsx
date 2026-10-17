"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { checkoutAction, lookupCodeAction } from "@/app/dashboard/pharmacy/actions";
import { BarcodeInput } from "@/components/pharmacy/barcode-input";
import { ToneBadge } from "@/components/pharmacy/badges";
import { FormMessage, selectClass } from "@/components/pharmacy/forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_METHODS, formatDate, formatMoney, productLabel, unitLabel } from "@/lib/pharmacy/format";

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const newRequestId = () => crypto.randomUUID();

// Point of sale. Lines are batches: scanning a product adds its FEFO batch
// (earliest-expiring sellable batch); staff may pick another batch. Totals
// here are a preview; the server prices every line from stored data,
// checks stock and deducts it in one transaction. The request id makes a
// double click or retry return the same sale instead of selling twice.
export function PosTerminal({ pharmacy }) {
  const [lines, setLines] = useState([]);
  const [matches, setMatches] = useState([]);
  const [notice, setNotice] = useState(null);
  const [discount, setDiscount] = useState("0");
  const [method, setMethod] = useState("cash");
  const [tendered, setTendered] = useState("");
  const [customerRef, setCustomerRef] = useState("");
  const [paymentRef, setPaymentRef] = useState("");
  const [result, setResult] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [looking, startLookup] = useTransition();
  const [paying, startPaying] = useTransition();
  const requestId = useRef(newRequestId());
  // Latest lines for lookups that finish after another scan changed the bill.
  const linesRef = useRef(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  function addFromLookup(lookup, scanned) {
    const product = lookup.product;
    const sellable = lookup.batches.filter((b) => b.sellable);
    if (sellable.length === 0) {
      const blocked = lookup.batches.find((b) => b.quantityOnHand > 0);
      setNotice({
        tone: "red",
        text: blocked
          ? `${productLabel(product)} has no sellable stock (${blocked.expiryStatus === "expired" ? "expired" : blocked.quantityHeld ? "held by a discrepancy report" : blocked.quantityReserved ? "reserved for returns" : blocked.batchStatus}).`
          : `${productLabel(product)} is out of stock at this pharmacy.`,
      });
      return;
    }
    const batchId = lookup.suggestedBatchId ?? sellable[0].batchId;
    const fefoBatchId = sellable[0].batchId;
    const current = linesRef.current;
    const existing = current.find((l) => l.batchId === batchId);
    if (existing) {
      const batch = existing.batches.find((b) => b.batchId === batchId);
      if (Number(existing.quantity) >= batch.quantityAvailable) {
        setNotice({ tone: "amber", text: `Only ${batch.quantityAvailable} ${unitLabel(product)} of batch ${batch.batchNumber} available.` });
        return;
      }
    }
    const next = existing
      ? current.map((l) => (l.batchId === batchId ? { ...l, quantity: Number(l.quantity) + 1 } : l))
      : [...current, { key: crypto.randomUUID(), product, batches: sellable, batchId, fefoBatchId, quantity: 1 }];
    linesRef.current = next;
    setLines(next);
    const chosen = sellable.find((b) => b.batchId === batchId);
    setNotice({
      tone: batchId === fefoBatchId ? "green" : "amber",
      text:
        `Added ${productLabel(product)} · batch ${chosen.batchNumber} (exp ${formatDate(chosen.expiryDate)})` +
        (batchId === fefoBatchId ? "" : ` — scanned batch is not the earliest expiring (${sellable[0].batchNumber}).`),
    });
    setMatches([]);
    setResult(null);
    if (scanned) setReceipt(null);
  }

  function lookup(code, medicineId) {
    setNotice(null);
    startLookup(async () => {
      const response = await lookupCodeAction(code, medicineId);
      if (!response.ok) return setNotice({ tone: "red", text: response.error });
      const r = response.result;
      if (r.matches?.length) {
        setMatches(r.matches);
        return setNotice({ tone: "blue", text: `${r.matches.length} products match "${code}". Choose one.` });
      }
      if (!r.product) return setNotice({ tone: "red", text: `Nothing found for "${code}".` });
      addFromLookup(r, true);
    });
  }

  const update = (key, changes) => setLines((current) => current.map((l) => (l.key === key ? { ...l, ...changes } : l)));
  const remove = (key) => setLines((current) => current.filter((l) => l.key !== key));

  const totals = useMemo(() => {
    const subtotal = round2(
      lines.reduce((t, l) => t + round2((l.batches.find((b) => b.batchId === l.batchId)?.unitPrice ?? 0) * (Number(l.quantity) || 0)), 0)
    );
    const pct = Math.min(Math.max(Number(discount) || 0, 0), pharmacy.maxDiscountPercent);
    const discountAmount = round2((subtotal * pct) / 100);
    const tax = round2(((subtotal - discountAmount) * pharmacy.taxRatePercent) / 100);
    const total = round2(subtotal - discountAmount + tax);
    return { subtotal, discountAmount, tax, total, change: method === "cash" && tendered !== "" ? round2(Number(tendered) - total) : null };
  }, [lines, discount, method, tendered, pharmacy]);

  const invalid = lines.some((l) => {
    const batch = l.batches.find((b) => b.batchId === l.batchId);
    return !Number.isInteger(Number(l.quantity)) || Number(l.quantity) < 1 || Number(l.quantity) > batch.quantityAvailable;
  });

  function checkout() {
    setResult(null);
    startPaying(async () => {
      const response = await checkoutAction({
        clientRequestId: requestId.current,
        items: lines.map((l) => ({ batchId: l.batchId, quantity: Number(l.quantity) })),
        discountPercent: Number(discount) || 0,
        paymentMethod: method,
        amountTendered: method === "cash" ? tendered : undefined,
        paymentReference: paymentRef || undefined,
        customerRef: customerRef || undefined,
      });
      if (!response.ok) return setResult(response);
      setReceipt(response.sale);
      setLines([]);
      setTendered("");
      setDiscount("0");
      setCustomerRef("");
      setPaymentRef("");
      setNotice(null);
      requestId.current = newRequestId();
    });
  }

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <BarcodeInput id="pos-scan" onScan={(code) => lookup(code)} busy={looking} disabled={paying} />
            {notice && (
              <div
                role="status"
                className={`rounded-lg border px-3 py-2 text-sm ${
                  { red: "border-red-200 bg-red-50 text-red-700", amber: "border-amber-200 bg-amber-50 text-amber-900", green: "border-emerald-200 bg-emerald-50 text-emerald-800", blue: "border-sky-200 bg-sky-50 text-sky-900" }[notice.tone]
                }`}
              >
                {notice.text}
              </div>
            )}
            {matches.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {matches.map((m) => (
                  <li key={m.id}>
                    <Button variant="outline" size="sm" onClick={() => lookup("", m.id)}>
                      {productLabel(m)} {m.brandName ? `· ${m.brandName}` : ""}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bill</CardTitle>
            <CardDescription>FEFO: the earliest-expiring sellable batch is chosen first.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {lines.length === 0 ? (
              <p className="px-4 pb-2 text-sm text-muted-foreground">Scan a product to start a bill.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Product</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead className="w-28">Qty</TableHead>
                    <TableHead className="text-right">Unit price</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                    <TableHead className="pr-4" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => {
                    const batch = l.batches.find((b) => b.batchId === l.batchId);
                    const over = Number(l.quantity) > batch.quantityAvailable;
                    return (
                      <TableRow key={l.key} className="align-top">
                        <TableCell className="pl-4">
                          <div className="font-medium">{productLabel(l.product)}</div>
                          <div className="text-xs text-muted-foreground">{l.product.brandName}</div>
                        </TableCell>
                        <TableCell>
                          <select
                            className={`${selectClass} w-52`}
                            value={l.batchId}
                            aria-label="Batch"
                            onChange={(e) => update(l.key, { batchId: e.target.value })}
                          >
                            {l.batches.map((b) => (
                              <option key={b.batchId} value={b.batchId} disabled={lines.some((o) => o.key !== l.key && o.batchId === b.batchId)}>
                                {b.batchNumber} · exp {formatDate(b.expiryDate)} · {b.quantityAvailable} left{b.batchId === l.fefoBatchId ? " · FEFO" : ""}
                              </option>
                            ))}
                          </select>
                          {l.batchId !== l.fefoBatchId && <ToneBadge tone="amber" className="mt-1">Not FEFO</ToneBadge>}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={1}
                            max={batch.quantityAvailable}
                            step={1}
                            value={l.quantity}
                            aria-invalid={over || undefined}
                            aria-label="Quantity"
                            onChange={(e) => update(l.key, { quantity: e.target.value })}
                          />
                          <span className="text-xs text-muted-foreground">{unitLabel(l.product)}</span>
                          {over && <p className="text-xs text-red-700">Only {batch.quantityAvailable} available</p>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(batch.unitPrice)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(round2(batch.unitPrice * (Number(l.quantity) || 0)))}</TableCell>
                        <TableCell className="pr-4">
                          <Button variant="ghost" size="icon-sm" onClick={() => remove(l.key)} aria-label={`Remove ${productLabel(l.product)}`}>
                            <Trash2 size={14} />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
            <CardDescription>Preview; the server calculates the final bill.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Subtotal</dt>
              <dd className="text-right tabular-nums">{formatMoney(totals.subtotal)}</dd>
              <dt className="text-muted-foreground">Discount</dt>
              <dd className="text-right tabular-nums">− {formatMoney(totals.discountAmount)}</dd>
              <dt className="text-muted-foreground">Tax ({pharmacy.taxRatePercent}%)</dt>
              <dd className="text-right tabular-nums">{formatMoney(totals.tax)}</dd>
              <dt className="font-semibold">Total</dt>
              <dd className="text-right text-lg font-semibold tabular-nums">{formatMoney(totals.total)}</dd>
            </dl>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="discount">Discount % (max {pharmacy.maxDiscountPercent})</Label>
                <Input id="discount" type="number" min={0} max={pharmacy.maxDiscountPercent} step="0.5" value={discount} onChange={(e) => setDiscount(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="method">Payment</Label>
                <select id="method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value)}>
                  {Object.entries(PAYMENT_METHODS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {method === "cash" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tendered">Cash received</Label>
                <Input id="tendered" type="number" min={0} step="0.01" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                {totals.change !== null && (
                  <span className={`text-sm ${totals.change < 0 ? "text-red-700" : "text-muted-foreground"}`}>
                    {totals.change < 0 ? `Short by ${formatMoney(-totals.change)}` : `Change ${formatMoney(totals.change)}`}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="paymentRef">Payment reference</Label>
                <Input id="paymentRef" value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="Card slip / transaction no." />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="customerRef">Customer / prescription reference (optional)</Label>
              <Input id="customerRef" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)} />
            </div>
            <FormMessage state={result} />
            <Button size="lg" onClick={checkout} disabled={paying || lines.length === 0 || invalid || (method === "cash" && (tendered === "" || totals.change < 0))}>
              {paying ? "Completing sale…" : `Complete sale · ${formatMoney(totals.total)}`}
            </Button>
          </CardContent>
        </Card>

        {receipt && <Receipt sale={receipt} pharmacy={pharmacy} />}
      </div>
    </div>
  );
}

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function Receipt({ sale, pharmacy }) {
  function print() {
    const rows = sale.items
      .map(
        (i) =>
          `<tr><td>${esc(productLabel(i.product))}<br><small>Batch ${esc(i.batchNumber)} · exp ${esc(formatDate(i.expiryDate))}</small></td><td style="text-align:right">${i.quantity} × ${i.unitPrice.toFixed(2)}</td><td style="text-align:right">${i.lineTotal.toFixed(2)}</td></tr>`
      )
      .join("");
    const win = window.open("", "receipt", "width=380,height=640");
    if (!win) return;
    win.document.write(`<!doctype html><title>${esc(sale.saleNumber)}</title><body style="font:13px system-ui;margin:16px">
      <h3 style="margin:0">${esc(pharmacy.name)}</h3><p style="margin:2px 0 10px">${esc(pharmacy.address)}</p>
      <p>Receipt ${esc(sale.saleNumber)}<br>${new Date(sale.soldAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" })}<br>Served by ${esc(sale.servedBy ?? "staff")}</p>
      <table style="width:100%;border-collapse:collapse">${rows}</table><hr>
      <p style="text-align:right">Subtotal ${sale.subtotal.toFixed(2)}<br>Discount −${sale.discountAmount.toFixed(2)}<br>Tax ${sale.taxAmount.toFixed(2)}<br><b>Total ${pharmacy.currency} ${sale.totalAmount.toFixed(2)}</b><br>${PAYMENT_METHODS[sale.paymentMethod]} ${sale.amountTendered?.toFixed(2) ?? ""} · change ${sale.changeDue?.toFixed(2) ?? "0.00"}</p>
      <script>window.print()</script></body>`);
    win.document.close();
  }
  return (
    <Card className="border-emerald-200">
      <CardHeader>
        <CardTitle>Sale {sale.saleNumber} completed</CardTitle>
        <CardDescription>Stock was deducted. Total {formatMoney(sale.totalAmount)}{sale.changeDue ? ` · change ${formatMoney(sale.changeDue)}` : ""}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <ul className="flex flex-col gap-1">
          {sale.items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2">
              <span>
                {i.quantity} × {productLabel(i.product)} <span className="text-xs text-muted-foreground">({i.batchNumber})</span>
              </span>
              <span className="tabular-nums">{formatMoney(i.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <Button variant="outline" onClick={print}>
          Print receipt
        </Button>
      </CardContent>
    </Card>
  );
}
