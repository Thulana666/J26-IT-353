import Link from "next/link";
import { pharmacyApi } from "@/lib/pharmacy/api";
import { getPharmacyContext, safe } from "@/lib/pharmacy/page-data";
import {
  DISCREPANCY_STATUS,
  DISCREPANCY_TYPES,
  EXPIRY_STATUS,
  ORDER_STATUS,
  SHIPMENT_STATUS,
  itemState,
  MOVEMENT_TYPES,
  RISK,
  SAFETY_METHODS,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNum,
  packsAndUnits,
  productLabel,
  unitLabel,
} from "@/lib/pharmacy/format";
import { adjustStockAction } from "@/app/dashboard/pharmacy/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { DiscrepancyHold } from "@/components/pharmacy/discrepancy-hold";
import { StatusBadge, ToneBadge } from "@/components/pharmacy/badges";
import { StockLevelChart } from "@/components/pharmacy/charts";
import { ActionForm, SelectField, TextField } from "@/components/pharmacy/forms";
import { PharmacyRealtime } from "@/components/pharmacy/pharmacy-realtime";
import { DiscrepancyForm } from "@/components/pharmacy/discrepancy-form";
import { DefinitionList, EmptyState, LoadError } from "@/components/pharmacy/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Product | Pharmacy | PharmaTwin" };

export default async function ProductDetailPage({ params, searchParams }) {
  const { medicineId } = await params;
  // Opened from the Receiving page for a disputed item: ?shipment=&item=&code=
  const { shipment: shipmentId, item: itemId, code } = await searchParams;
  const [[data, error], [context], [shipmentData, shipmentError]] = await Promise.all([
    safe(pharmacyApi(`/pharmacy/inventory/products/${medicineId}`)),
    getPharmacyContext(),
    shipmentId ? safe(pharmacyApi(`/pharmacy/shipments/${shipmentId}`)) : [null, null],
  ]);
  if (error) {
    return (
      <>
        <PageHeader title="Product" mock={false} />
        <LoadError message={error} />
      </>
    );
  }

  const { product, totals, settings, recommendation: rec } = data;
  const units = unitLabel(product);
  const isAdmin = context?.user?.isAdmin;
  return (
    <>
      <PharmacyRealtime tables={["pharmacy_inventory"]} />
      <PageHeader title={productLabel(product)} description={[product.genericName, product.dosageForm, product.category].filter(Boolean).join(" · ")} mock={false}>
        <Button variant="outline" nativeButton={false} render={<Link href={`/dashboard/pharmacy/analytics?product=${product.id}`} />}>
          Demand analytics
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link href="/dashboard/pharmacy/inventory" />}>
          Back to inventory
        </Button>
      </PageHeader>

      {shipmentError && <LoadError title="Shipment could not be loaded" message={shipmentError} />}
      {shipmentData && <ShipmentContext data={shipmentData} product={product} itemId={itemId} code={code} />}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Product</CardTitle>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                ["Brand", product.brandName],
                ["Manufacturer", product.manufacturer],
                ["Strength", product.strength],
                ["Dispensing unit", product.dispensingUnit ?? "unit"],
                ["Warehouse pack", `1 ${product.packUnit} = ${formatNum(product.unitsPerPack)} ${units}`],
                ["Storage", product.storageCondition],
                ["Controlled", product.isControlled ? "Yes" : "No"],
                ["Unit cost", formatMoney(product.unitCost)],
                ["Retail price", formatMoney(product.retailPrice)],
                [
                  "Barcodes",
                  data.barcodes.length === 0 ? (
                    "—"
                  ) : (
                    <span className="flex flex-col">
                      {data.barcodes.map((b) => (
                        <span key={b.id} className="font-mono text-xs">
                          {b.barcode} <span className="text-muted-foreground">({b.packagingLevel === "pack" ? product.packUnit : "unit"}, {b.symbology})</span>
                        </span>
                      ))}
                    </span>
                  ),
                ],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stock</CardTitle>
            <CardDescription>Dispensing units ({units}).</CardDescription>
          </CardHeader>
          <CardContent>
            <DefinitionList
              items={[
                ["On hand", formatNum(totals.onHand)],
                ["Reserved for returns", formatNum(totals.reserved)],
                ["Held by discrepancy reports", formatNum(totals.held ?? 0)],
                ["Available to sell", <strong key="a">{formatNum(totals.available)}</strong>],
                ["Lead time", `${settings.leadTimeDays} days`],
                ["Review period", `${settings.reviewPeriodDays} days`],
                ["Safety stock", SAFETY_METHODS[settings.safety.method]],
                ["Low-stock threshold", settings.lowStockThreshold ?? "reorder point"],
                ["Settings", data.hasCustomSettings ? "Product-specific" : "Pharmacy defaults"],
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Reorder recommendation</CardTitle>
            <CardDescription>{rec ? `Generated ${formatDateTime(rec.generatedAt)} · ${rec.status}` : "Recalculate recommendations on Analytics to get one."}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {rec ? (
              <>
                <DefinitionList
                  items={[
                    ["Recommended Q*", <strong key="q">{packsAndUnits(rec.recommendedPacks, product)}</strong>],
                    ["Moving-average demand", `${formatNum(rec.forecastDailyDemand)} ${units}/day`],
                    ["Days of cover", rec.daysOfCover ?? "—"],
                    ["Stockout risk", <StatusBadge key="r" map={RISK} value={rec.stockoutRisk} />],
                    ["Reorder point", formatNum(rec.reorderPoint)],
                    ["Target stock", formatNum(rec.targetStock)],
                  ]}
                />
                <p className="text-xs text-muted-foreground">{rec.explanation}</p>
              </>
            ) : (
              <EmptyState title="No recommendation yet" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Batches</CardTitle>
          <CardDescription>Earliest expiry first. Sold-out batches stay listed with zero stock for traceability.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Batch</TableHead>
                <TableHead>Manufactured</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">Reserved (returns)</TableHead>
                <TableHead className="text-right">Held (discrepancy)</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="pr-4 text-right">Unit price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.batches.map((b) => (
                <TableRow key={b.inventoryId} className={b.quantityOnHand === 0 ? "text-muted-foreground" : undefined}>
                  <TableCell className="pl-4 font-mono text-xs">{b.batchNumber}</TableCell>
                  <TableCell>{formatDate(b.manufacturingDate)}</TableCell>
                  <TableCell>
                    {formatDate(b.expiryDate)} <span className="text-xs text-muted-foreground">({b.daysToExpiry} d)</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge map={EXPIRY_STATUS} value={b.expiryStatus} />
                      {b.batchStatus !== "active" && <ToneBadge tone="red">{b.batchStatus}</ToneBadge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(b.quantityOnHand)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(b.quantityReserved)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(b.quantityHeld)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNum(b.quantityAvailable)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(b.unitCost)}</TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">{formatMoney(b.unitPrice)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Closing stock, last 30 days</CardTitle>
            <CardDescription>
              {formatNum(data.dailySales.reduce((t, d) => t + d.sold, 0))} {units} sold in the period.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StockLevelChart history={data.dailySales} reorderPoint={rec?.reorderPoint ?? null} unitLabel={units} />
          </CardContent>
        </Card>
        {isAdmin && (
          <Card>
            <CardHeader>
              <CardTitle>Stock count correction</CardTitle>
              <CardDescription>Admins only. Recorded as an adjustment in the stock ledger and audit log.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={adjustStockAction} submitLabel="Record adjustment">
                <SelectField
                  id="batchId"
                  label="Batch"
                  options={data.batches.map((b) => ({ value: b.batchId, label: `${b.batchNumber} (${b.quantityOnHand} on hand)` }))}
                />
                <TextField id="change" label={`Change (${units}, negative to remove)`} type="number" step="1" required />
                <TextField id="reason" label="Reason" placeholder="e.g. physical count 2026-10-10" required />
              </ActionForm>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shipment discrepancies for this product</CardTitle>
          <CardDescription>Reports recorded at this pharmacy, with the warehouse&apos;s resolution.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {data.discrepancies.length === 0 ? (
            <EmptyState title="No discrepancies reported" className="mx-4" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Report</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">Expected / observed</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.discrepancies.map((d) => (
                  <TableRow key={d.id} className="align-top">
                    <TableCell className="pl-4">
                      <div className="font-mono text-xs">{d.reportNumber}</div>
                      <div className="text-xs text-muted-foreground">{formatDateTime(d.reportedAt)}</div>
                    </TableCell>
                    <TableCell>
                      <Link href={`/dashboard/pharmacy/receiving/${d.shipmentId}`} className="font-mono text-xs hover:underline">
                        {d.shipmentNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{DISCREPANCY_TYPES[d.type]}</TableCell>
                    <TableCell className="font-mono text-xs">{d.batchNumber ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.expectedQuantity ?? "—"} / {d.actualQuantity ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-72 text-xs whitespace-normal">
                      {d.notes}
                      {d.resolutionNotes && <div className="text-emerald-700">Warehouse: {d.resolutionNotes}</div>}
                    </TableCell>
                    <TableCell className="pr-4">
                      <StatusBadge map={DISCREPANCY_STATUS} value={d.status} />
                      <DiscrepancyHold report={d} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stock movements</CardTitle>
          <CardDescription>Latest 100 entries of the stock ledger (receipts, sales, returns, adjustments).</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {data.movements.length === 0 ? (
            <EmptyState title="No movements yet" className="mx-4" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Batch</TableHead>
                  <TableHead className="text-right">On hand ±</TableHead>
                  <TableHead className="text-right">Reserved ±</TableHead>
                  <TableHead className="text-right">Held ±</TableHead>
                  <TableHead className="text-right">On hand after</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead className="pr-4">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.movements.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-4 text-xs">{formatDateTime(m.createdAt)}</TableCell>
                    <TableCell>{MOVEMENT_TYPES[m.type] ?? m.type}</TableCell>
                    <TableCell className="font-mono text-xs">{m.batchNumber}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.onHandChange > 0 ? `+${m.onHandChange}` : m.onHandChange || ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.reservedChange > 0 ? `+${m.reservedChange}` : m.reservedChange || ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.heldChange > 0 ? `+${m.heldChange}` : m.heldChange || ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNum(m.onHandAfter)}</TableCell>
                    <TableCell className="text-xs">{m.performedBy ?? "System"}</TableCell>
                    <TableCell className="pr-4 text-xs text-muted-foreground">{m.notes}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// The disputed item in its shipment: warehouse-provided batch details, the
// expected quantity, the original order, and the discrepancy form.
function ShipmentContext({ data, product, itemId, code }) {
  const { shipment, order, discrepancies } = data;
  const item = shipment.items.find((i) => i.id === itemId && i.product?.id === product.id) ?? null;
  const orderLine = order.items.find((i) => (item ? i.id === item.orderItemId : i.medicineId === product.id));
  const itemReports = item
    ? discrepancies.filter((d) => d.shipmentItemId === item.id)
    : discrepancies.filter((d) => !d.shipmentItemId && d.product?.id === product.id);
  const [stateLabel, stateTone] = item ? itemState(item) : ["Not part of this shipment", "red"];
  const back = `/dashboard/pharmacy/receiving/${shipment.id}`;
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Discrepancy for shipment {shipment.shipmentNumber}
          <StatusBadge map={SHIPMENT_STATUS} value={shipment.status} />
          <ToneBadge tone={stateTone}>{stateLabel}</ToneBadge>
        </CardTitle>
        <CardDescription>
          {code ? (
            <>
              Scanned <span className="font-mono">{code}</span>.{" "}
            </>
          ) : null}
          {item
            ? "Compare the item in hand with the warehouse details below and record what is wrong."
            : "This product was not ordered in this shipment. Record it as an incorrect or unexpected item; it will not be added to stock."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <DefinitionList
            items={[
              ["Drug / product", productLabel(product)],
              ["Brand", product.brandName],
              ["Manufacturer", product.manufacturer],
              ["Batch number", item ? <span key="b" className="font-mono">{item.batch?.batchNumber}</span> : "— (not shipped)"],
              ["Manufacture date", item ? formatDate(item.batch?.manufacturingDate) : "—"],
              ["Expiry date", item ? formatDate(item.batch?.expiryDate) : "—"],
              ["Expected (shipped)", item ? `${item.quantityShipped} ${product.packUnit}(s) = ${item.quantityShipped * item.unitsPerPack} ${unitLabel(product)}` : "0"],
              ["Ordered", orderLine ? `${orderLine.quantityOrdered} ${product.packUnit}(s)` : "Not ordered"],
              [
                "Order",
                <span key="o">
                  {order.orderNumber} <StatusBadge map={ORDER_STATUS} value={order.status} />
                </span>,
              ],
              ["Dispatched", formatDateTime(shipment.dispatchedAt)],
            ]}
          />
          {itemReports.length > 0 && (
            <div className="text-sm">
              <p className="font-medium">Already reported</p>
              <ul className="text-xs">
                {itemReports.map((d) => (
                  <li key={d.id}>
                    <span className="font-mono">{d.reportNumber}</span> {DISCREPANCY_TYPES[d.type]} · observed {d.actualQuantity ?? "—"}{" "}
                    <StatusBadge map={DISCREPANCY_STATUS} value={d.status} />
                    <DiscrepancyHold report={d} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div>
          {shipment.status !== "in_transit" && item?.verificationStatus === "matched" && (
            <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This item is already in stock. Recording a missing, damaged or incorrect quantity holds those units out of available stock
              until the warehouse resolves the report; you then release them or write them off.
            </p>
          )}
          <DiscrepancyForm
            shipmentId={shipment.id}
            item={item ? { id: item.id, quantityShipped: item.quantityShipped } : null}
            medicineId={item ? null : product.id}
            barcode={code ?? ""}
            packUnit={product.packUnit ?? "pack"}
            backHref={back}
          />
        </div>
      </CardContent>
    </Card>
  );
}
