"use client";

import Link from "next/link";
import { Bell, PackageCheck, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PharmacySwitcher } from "@/components/pharmacy/pharmacy-switcher";
import { ToneBadge } from "@/components/pharmacy/badges";
import { ROLES } from "@/lib/pharmacy/format";

// Bar above every pharmacy page: the pharmacy being worked in (a switcher for
// admins), product search, shipments to receive and alerts.
export function PharmacyToolbar({ context }) {
  const { user, pharmacies, currentPharmacy: current, counts } = context;

  if (!user.canUsePharmacy) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {user.role === "warehouse_staff"
          ? "Warehouse dispatch, discrepancy resolution and return reception are handled in the warehouse application."
          : `Your role (${ROLES[user.role] ?? user.role}) has no access to the pharmacy module.`}{" "}
        Pharmacy pages need the pharmacy staff role{user.role === "pharmacy_staff" ? " and an assigned pharmacy" : ""}; an admin can set this
        in Pharmacy → Settings.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 px-3 py-2 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {user.isAdmin && pharmacies.length > 0 ? (
          <PharmacySwitcher pharmacies={pharmacies} currentId={current?.id} />
        ) : (
          current && <span className="truncate text-sm font-medium">{current.name}</span>
        )}
        {current?.code?.startsWith("SAMPLE") && <ToneBadge tone="violet">Sample pharmacy</ToneBadge>}
        <ToneBadge tone="gray">{ROLES[user.role] ?? user.role}</ToneBadge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {current && (
          <form action="/dashboard/pharmacy/inventory" className="flex items-center gap-1" role="search">
            <Input name="q" placeholder="Search products, batches, barcodes" aria-label="Search inventory" className="h-8 w-64" />
            <Button type="submit" variant="outline" size="icon-sm" aria-label="Search">
              <Search size={14} />
            </Button>
          </form>
        )}
        {current && (
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/dashboard/pharmacy/receiving" />}>
            <PackageCheck size={14} />
            To receive
            {counts.pendingReceipts > 0 && (
              <ToneBadge tone="blue" className="ml-1">
                {counts.pendingReceipts}
              </ToneBadge>
            )}
          </Button>
        )}
        {current && (
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/dashboard/pharmacy/alerts" />}>
            <Bell size={14} />
            Alerts
            {counts.openAlerts > 0 && (
              <ToneBadge tone={counts.criticalAlerts > 0 ? "red" : "amber"} className="ml-1">
                {counts.openAlerts}
              </ToneBadge>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
