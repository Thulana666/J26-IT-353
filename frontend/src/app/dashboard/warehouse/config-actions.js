"use server";

import { warehouseApi } from "@/lib/warehouse/api";
import { checked, failure, refreshWarehouse, text } from "@/lib/warehouse/action-helpers";

// "true" / "false" from an "Unchanged / Yes / No" select; undefined leaves the field as it is.
const choice = (formData, key) => {
  const value = text(formData, key);
  return value === "true" ? true : value === "false" ? false : undefined;
};

// Admin actions: warehouse structure, medicines and staff access. The
// backend rejects every one of them for non-admins.

async function run(path, method, body, message) {
  try {
    const result = await warehouseApi(path, { method, body });
    refreshWarehouse();
    return { ok: true, message: typeof message === "function" ? message(result) : message };
  } catch (error) {
    return failure(error);
  }
}

export async function createWarehouseAction(_previous, formData) {
  return run("/warehouse/warehouses", "POST", {
    code: text(formData, "code"),
    name: text(formData, "name"),
    address: text(formData, "address"),
  }, (r) => `Warehouse ${r.warehouse.code} created.`);
}

export async function updateWarehouseAction(_previous, formData) {
  return run(`/warehouse/warehouses/${text(formData, "warehouseId")}`, "PATCH", {
    name: text(formData, "name"),
    address: text(formData, "address") ?? null,
    isActive: checked(formData, "isActive"),
  }, "Warehouse saved.");
}

export async function createZoneAction(_previous, formData) {
  return run("/warehouse/storage/zones", "POST", {
    warehouseId: text(formData, "warehouseId"),
    code: text(formData, "code"),
    name: text(formData, "name"),
    zoneType: text(formData, "zoneType"),
    storageCondition: text(formData, "storageCondition"),
    minTempC: text(formData, "minTempC"),
    maxTempC: text(formData, "maxTempC"),
    isSecure: checked(formData, "isSecure"),
  }, (r) => `Zone ${r.zone.code} created.`);
}

export async function createRackAction(_previous, formData) {
  return run("/warehouse/storage/racks", "POST", {
    zoneId: text(formData, "zoneId"),
    code: text(formData, "code"),
    distanceToDispatchM: text(formData, "distanceToDispatchM"),
  }, (r) => `Rack ${r.rack.code} created.`);
}

export async function createLocationAction(_previous, formData) {
  return run("/warehouse/storage/locations", "POST", {
    rackId: text(formData, "rackId"),
    code: text(formData, "code"),
    level: text(formData, "level"),
    capacityUnits: text(formData, "capacityUnits"),
    accessibility: text(formData, "accessibility"),
  }, (r) => `Location ${r.location.code} created.`);
}

export async function updateLocationAction(_previous, formData) {
  return run(`/warehouse/storage/locations/${text(formData, "locationId")}`, "PATCH", {
    capacityUnits: text(formData, "capacityUnits"),
    accessibility: text(formData, "accessibility"),
    isActive: choice(formData, "isActive"),
  }, (r) => `Location ${r.location.code} saved.`);
}

export async function createMedicineAction(_previous, formData) {
  return run("/medicines", "POST", {
    name: text(formData, "name"),
    genericName: text(formData, "genericName"),
    medicineCategoryId: text(formData, "medicineCategoryId"),
    dosageForm: text(formData, "dosageForm"),
    strength: text(formData, "strength"),
    unit: text(formData, "unit"),
    storageCondition: text(formData, "storageCondition"),
    isControlled: checked(formData, "isControlled"),
  }, (r) => `Medicine ${r.medicine.name} registered.`);
}

export async function updateMedicineAction(_previous, formData) {
  return run(`/medicines/${text(formData, "medicineId")}`, "PATCH", {
    storageCondition: text(formData, "storageCondition"),
    isControlled: choice(formData, "isControlled"),
    isActive: choice(formData, "isActive"),
  }, (r) => `${r.medicine.name} saved.`);
}

// Role, status and assignment in one update: a pharmacy for pharmacy staff,
// a warehouse for warehouse staff and admins (the backend checks the rules).
export async function updateStaffAction(_previous, formData) {
  return run(`/warehouse/staff/${text(formData, "userId")}`, "PATCH", {
    role: text(formData, "role"),
    status: text(formData, "status"),
    pharmacyId: text(formData, "pharmacyId") ?? null,
    warehouseId: text(formData, "warehouseId") ?? null,
  }, (r) => `${r.staff.email}: ${r.staff.role.replace("_", " ")}, ${r.staff.status}.`);
}
