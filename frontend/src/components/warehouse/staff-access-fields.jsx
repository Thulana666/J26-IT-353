"use client";

import { useState } from "react";
import { ROLE_LABELS } from "@/lib/warehouse/format";
import { SelectField } from "./fields";
import styles from "./warehouse.module.css";

const ROLE_OPTIONS = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }));
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

// Role and status, plus the assignment the chosen role takes: a pharmacy for
// pharmacy staff, a warehouse for warehouse staff (required) and admins
// (optional). The backend applies the same rules.
export function StaffAccessFields({ user, pharmacies, warehouses }) {
  const [role, setRole] = useState(user.role);
  return (
    <div className={styles.formGrid}>
      <SelectField
        id={`role-${user.id}`}
        name="role"
        label="Role"
        value={role}
        onChange={(event) => setRole(event.target.value)}
        options={ROLE_OPTIONS}
      />
      <SelectField id={`status-${user.id}`} name="status" label="Status" defaultValue={user.status} options={STATUS_OPTIONS} />
      {role === "pharmacy_staff" && (
        <SelectField
          id={`pharmacy-${user.id}`}
          name="pharmacyId"
          label="Pharmacy"
          required
          full
          defaultValue={user.pharmacyId ?? ""}
          placeholder="Choose a pharmacy…"
          options={pharmacies.map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
        />
      )}
      {(role === "warehouse_staff" || role === "admin") && (
        <SelectField
          id={`warehouse-${user.id}`}
          name="warehouseId"
          label={role === "admin" ? "Warehouse (optional)" : "Warehouse"}
          required={role === "warehouse_staff"}
          full
          defaultValue={user.warehouseId ?? ""}
          placeholder={role === "admin" ? "All warehouses" : "Choose a warehouse…"}
          options={warehouses.map((w) => ({ value: w.id, label: `${w.code} – ${w.name}`, disabled: !w.isActive }))}
        />
      )}
    </div>
  );
}
