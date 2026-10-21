import { pharmacyApi } from "@/lib/pharmacy/api";
import { getPharmacyContext, safe } from "@/lib/pharmacy/page-data";
import { ROLES, SAFETY_METHODS, formatMoney, productLabel, unitLabel } from "@/lib/pharmacy/format";
import {
  addBarcodeAction,
  createPharmacyAction,
  removeBarcodeAction,
  saveReorderSettingsAction,
  updateDefaultsAction,
  updateProductAction,
  updateProfileAction,
  updateUserAction,
} from "@/app/dashboard/pharmacy/actions";
import { PageHeader } from "@/components/dashboard/page-header";
import { ToneBadge } from "@/components/pharmacy/badges";
import { ActionForm, InlineAction, SelectField, TextField } from "@/components/pharmacy/forms";
import { LoadError } from "@/components/pharmacy/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata = { title: "Settings | Pharmacy | PharmaTwin" };

const grid = "grid gap-3 sm:grid-cols-2 lg:grid-cols-3";

export default async function SettingsPage() {
  const [[context], [data, error]] = await Promise.all([getPharmacyContext(), safe(pharmacyApi("/pharmacy/settings"))]);
  const isAdmin = context?.user?.isAdmin;
  const [[users], [pharmacies], [products]] = isAdmin
    ? await Promise.all([
        safe(pharmacyApi("/pharmacy/admin/users")),
        safe(pharmacyApi("/pharmacy/admin/pharmacies")),
        safe(pharmacyApi("/pharmacy/admin/products")),
      ])
    : [[null], [null], [null]];

  if (error) {
    return (
      <>
        <PageHeader title="Settings" mock={false} />
        <LoadError message={error} />
      </>
    );
  }
  const p = data.pharmacy;
  const warehouseOptions = data.warehouses.map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }));

  return (
    <>
      <PageHeader title="Settings" description={`${p.name} (${p.code})`} mock={false} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Reorder defaults</CardTitle>
            <CardDescription>Used for every product without its own settings. Changes apply when recommendations are recalculated.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateDefaultsAction} submitLabel="Save defaults" resetOnSuccess={false}>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField id="defaultLeadTimeDays" label="Supplier lead time (days)" type="number" min={0} max={90} defaultValue={p.defaultLeadTimeDays} required />
                <TextField id="defaultReviewPeriodDays" label="Review period (days)" type="number" min={1} max={90} defaultValue={p.defaultReviewPeriodDays} required />
                <TextField
                  id="defaultServiceLevel"
                  label="Service level (0.50–0.999)"
                  type="number"
                  step="0.005"
                  min={0.5}
                  max={0.999}
                  defaultValue={p.defaultServiceLevel}
                  hint="Probability of not running out during lead time + review period."
                  required
                />
                <TextField id="burnRateWindowDays" label="Historical window (days)" hint="Burn rate and moving-average demand use the last N days of sales." type="number" min={7} max={365} defaultValue={p.burnRateWindowDays} required />
                <TextField id="nearExpiryDays" label="Near-expiry alert (days)" type="number" min={1} max={730} defaultValue={p.nearExpiryDays} required />
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pharmacy profile</CardTitle>
            <CardDescription>{data.canEditProfile ? "Admins only." : "Only admins can change the profile, tax and discount limits."}</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={updateProfileAction} submitLabel="Save profile" resetOnSuccess={false}>
              <fieldset disabled={!data.canEditProfile} className="grid gap-3 sm:grid-cols-2">
                <TextField id="name" label="Name" defaultValue={p.name} required />
                <SelectField id="warehouseId" label="Supplying warehouse" defaultValue={p.warehouseId ?? ""} placeholder="None" options={warehouseOptions} />
                <TextField id="address" label="Address" defaultValue={p.address ?? ""} />
                <TextField id="phone" label="Phone" defaultValue={p.phone ?? ""} />
                <TextField id="licenseNumber" label="Licence number" defaultValue={p.licenseNumber ?? ""} />
                <TextField id="taxRatePercent" label="Tax on sales (%)" type="number" step="0.01" min={0} max={100} defaultValue={p.taxRatePercent} required />
                <TextField id="maxDiscountPercent" label="Max discount (%)" type="number" step="0.5" min={0} max={100} defaultValue={p.maxDiscountPercent} required />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isActive" defaultChecked={p.isActive} className="size-4" /> Active
                </label>
              </fieldset>
            </ActionForm>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Reorder settings per product</CardTitle>
          <CardDescription>
            Leave a field empty to use the pharmacy default. Pack size comes from the product (whole warehouse packs are ordered); minimum order and
            storage capacity are applied to Q* after rounding.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Product</TableHead>
                <TableHead>Effective policy</TableHead>
                <TableHead className="pr-4">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map(({ product, stocked, custom, effective }) => (
                <TableRow key={product.id} className="align-top">
                  <TableCell className="pl-4">
                    <div className="font-medium">{productLabel(product)}</div>
                    <div className="flex gap-1">
                      {stocked ? <ToneBadge tone="green">Stocked</ToneBadge> : <ToneBadge>Not stocked</ToneBadge>}
                      {custom && <ToneBadge tone="blue">Custom</ToneBadge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    Lead {effective.leadTimeDays} d · review {effective.reviewPeriodDays} d · {SAFETY_METHODS[effective.safety.method]}
                    {effective.safety.method === "service_level" && ` ${(effective.safety.serviceLevel * 100).toFixed(1)}%`}
                    {effective.safety.method === "days_of_cover" && ` ${effective.safety.safetyDays} days`}
                    {effective.safety.method === "fixed_units" && ` ${effective.safety.safetyUnits} units`}
                    <div className="text-muted-foreground">
                      Min order {effective.minOrderPacks} {product.packUnit}(s) · capacity {effective.maxStockUnits ?? "unlimited"} · low-stock at{" "}
                      {effective.lowStockThreshold ?? "reorder point"}
                      {!effective.isActive && " · recommendations off"}
                    </div>
                  </TableCell>
                  <TableCell className="pr-4">
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">Edit…</summary>
                      <ActionForm
                        action={saveReorderSettingsAction}
                        submitLabel="Save"
                        size="sm"
                        resetOnSuccess={false}
                        className="mt-2 w-[min(40rem,80vw)]"
                        secondary={{ name: "intent", value: "reset", label: "Reset to defaults", disabled: !custom }}
                      >
                        <input type="hidden" name="medicineId" value={product.id} />
                        <div className={grid}>
                          <TextField id={`lt-${product.id}`} name="leadTimeDays" label="Lead time (days)" type="number" min={0} max={90} defaultValue={custom?.leadTimeDays ?? ""} placeholder={String(p.defaultLeadTimeDays)} />
                          <TextField id={`rp-${product.id}`} name="reviewPeriodDays" label="Review period (days)" type="number" min={1} max={90} defaultValue={custom?.reviewPeriodDays ?? ""} placeholder={String(p.defaultReviewPeriodDays)} />
                          <SelectField
                            id={`sm-${product.id}`}
                            name="safetyStockMethod"
                            label="Safety stock"
                            defaultValue={custom?.safetyStockMethod ?? "service_level"}
                            options={Object.entries(SAFETY_METHODS).map(([value, label]) => ({ value, label }))}
                          />
                          <TextField id={`sl-${product.id}`} name="serviceLevel" label="Service level" type="number" step="0.005" min={0.5} max={0.999} defaultValue={custom?.serviceLevel ?? ""} placeholder={String(p.defaultServiceLevel)} />
                          <TextField id={`sd-${product.id}`} name="safetyStockDays" label="Safety days" type="number" step="0.5" min={0} defaultValue={custom?.safetyStockDays ?? ""} />
                          <TextField id={`su-${product.id}`} name="safetyStockUnits" label={`Safety units (${unitLabel(product)})`} type="number" min={0} defaultValue={custom?.safetyStockUnits ?? ""} />
                          <TextField id={`ls-${product.id}`} name="lowStockThreshold" label="Low-stock alert at (units)" type="number" min={0} defaultValue={custom?.lowStockThreshold ?? ""} placeholder="reorder point" />
                          <TextField id={`mo-${product.id}`} name="minOrderPacks" label={`Minimum order (${product.packUnit}s)`} type="number" min={1} defaultValue={custom?.minOrderPacks ?? 1} />
                          <TextField id={`mx-${product.id}`} name="maxStockUnits" label="Storage capacity (units)" type="number" min={1} defaultValue={custom?.maxStockUnits ?? ""} placeholder="unlimited" />
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name="isActive" defaultChecked={custom?.isActive ?? true} className="size-4" /> Generate reorder recommendations
                        </label>
                      </ActionForm>
                    </details>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Users and access</CardTitle>
              <CardDescription>
                Pharmacy staff see only their pharmacy; warehouse staff handle orders, discrepancies and returns of all pharmacies; “user” has no pharmacy
                access. The database enforces the same rules (row level security).
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">User</TableHead>
                    <TableHead className="pr-4">Role, pharmacy and status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(users?.users ?? []).map((u) => (
                    <TableRow key={u.id} className="align-top">
                      <TableCell className="pl-4">
                        <div className="font-medium">{u.fullName || u.email}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                        {u.id === context.user.id && <ToneBadge tone="blue">You</ToneBadge>}
                      </TableCell>
                      <TableCell className="pr-4">
                        <ActionForm action={updateUserAction} submitLabel="Save" size="sm" resetOnSuccess={false} className="gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <div className="grid gap-2 sm:grid-cols-3">
                            <SelectField id={`role-${u.id}`} name="role" label="Role" defaultValue={u.role} options={Object.entries(ROLES).map(([value, label]) => ({ value, label }))} />
                            <SelectField
                              id={`ph-${u.id}`}
                              name="pharmacyId"
                              label="Pharmacy"
                              defaultValue={u.pharmacyId ?? ""}
                              placeholder="None"
                              options={(pharmacies?.pharmacies ?? []).map((ph) => ({ value: ph.id, label: ph.name }))}
                            />
                            <SelectField
                              id={`st-${u.id}`}
                              name="status"
                              label="Status"
                              defaultValue={u.status}
                              options={[
                                { value: "active", label: "Active" },
                                { value: "inactive", label: "Inactive" },
                              ]}
                            />
                          </div>
                        </ActionForm>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card>
              <CardHeader>
                <CardTitle>New pharmacy</CardTitle>
              </CardHeader>
              <CardContent>
                <ActionForm action={createPharmacyAction} submitLabel="Create pharmacy">
                  <TextField id="new-code" name="code" label="Code" placeholder="PH-GAL-01" required />
                  <TextField id="new-name" name="name" label="Name" required />
                  <SelectField id="new-wh" name="warehouseId" label="Supplying warehouse" placeholder="None" options={warehouseOptions} />
                  <TextField id="new-address" name="address" label="Address" />
                  <TextField id="new-phone" name="phone" label="Phone" />
                  <TextField id="new-licence" name="licenseNumber" label="Licence number" />
                </ActionForm>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Products and barcodes</CardTitle>
                <CardDescription>Pharmacy fields of the shared medicine catalogue. Prices are per dispensing unit and are copied onto shipments at dispatch.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {(products?.products ?? []).map((m) => (
                  <details key={m.id} className="rounded-lg border p-2">
                    <summary className="cursor-pointer text-sm">
                      <span className="font-medium">{productLabel(m)}</span>{" "}
                      <span className="text-muted-foreground">
                        · {m.brandName ?? "no brand"} · {m.packUnit} of {m.unitsPerPack} {unitLabel(m)} · {formatMoney(m.retailPrice)} · {m.barcodes.length} barcode(s)
                      </span>
                    </summary>
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <ActionForm action={updateProductAction} submitLabel="Save product" size="sm" resetOnSuccess={false}>
                        <input type="hidden" name="medicineId" value={m.id} />
                        <div className="grid gap-2 sm:grid-cols-2">
                          <TextField id={`b-${m.id}`} name="brandName" label="Brand" defaultValue={m.brandName ?? ""} />
                          <TextField id={`mf-${m.id}`} name="manufacturer" label="Manufacturer" defaultValue={m.manufacturer ?? ""} />
                          <TextField id={`du-${m.id}`} name="dispensingUnit" label="Dispensing unit" defaultValue={m.dispensingUnit ?? ""} placeholder="strip of 10 tablets" />
                          <TextField id={`up-${m.id}`} name="unitsPerPack" label={`Units per ${m.packUnit}`} type="number" min={1} defaultValue={m.unitsPerPack} required />
                          <TextField id={`uc-${m.id}`} name="unitCost" label="Unit cost" type="number" step="0.01" min={0} defaultValue={m.unitCost ?? ""} />
                          <TextField id={`rp-${m.id}`} name="retailPrice" label="Retail price" type="number" step="0.01" min={0} defaultValue={m.retailPrice ?? ""} />
                        </div>
                      </ActionForm>
                      <div className="flex flex-col gap-2">
                        <ul className="flex flex-col gap-1 text-sm">
                          {m.barcodes.map((b) => (
                            <li key={b.id} className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs">
                                {b.barcode} <span className="text-muted-foreground">({b.packagingLevel}, {b.symbology})</span>
                              </span>
                              <InlineAction action={removeBarcodeAction} fields={{ barcodeId: b.id }} label="Remove" variant="ghost" size="xs" confirm={`Remove barcode ${b.barcode}?`} />
                            </li>
                          ))}
                        </ul>
                        <ActionForm action={addBarcodeAction} submitLabel="Add barcode" size="sm">
                          <input type="hidden" name="medicineId" value={m.id} />
                          <div className="grid gap-2 sm:grid-cols-3">
                            <TextField id={`bc-${m.id}`} name="barcode" label="Barcode" required />
                            <SelectField
                              id={`sy-${m.id}`}
                              name="symbology"
                              label="Type"
                              options={["EAN13", "EAN8", "UPCA", "CODE128", "GS1_DATAMATRIX", "QR", "INTERNAL"].map((v) => ({ value: v, label: v }))}
                            />
                            <SelectField
                              id={`pl-${m.id}`}
                              name="packagingLevel"
                              label="On"
                              options={[
                                { value: "unit", label: "Dispensing unit" },
                                { value: "pack", label: m.packUnit },
                              ]}
                            />
                          </div>
                        </ActionForm>
                      </div>
                    </div>
                  </details>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
