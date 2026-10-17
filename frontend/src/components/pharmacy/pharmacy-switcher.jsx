"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { selectPharmacyAction } from "@/app/dashboard/pharmacy/actions";
import { selectClass } from "@/components/pharmacy/forms";

// Admins choose which pharmacy they work in (stored in a cookie).
export function PharmacySwitcher({ pharmacies, currentId }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleChange(event) {
    const id = event.target.value;
    startTransition(async () => {
      await selectPharmacyAction(id);
      router.refresh();
    });
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Pharmacy</span>
      <select className={`${selectClass} w-auto max-w-72`} value={currentId ?? ""} onChange={handleChange} disabled={pending}>
        {pharmacies.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isActive ? "" : " (inactive)"}
          </option>
        ))}
      </select>
    </label>
  );
}
