// Allowed values, matching the check constraints in
// supabase/migrations/20261008000000_create_warehouse_schema.sql.

module.exports = {
  STORAGE_CONDITIONS: ["ambient", "cool", "refrigerated", "frozen"],
  ZONE_TYPES: ["storage", "quarantine"],
  ACCESSIBILITY: ["high", "medium", "low"],
  BATCH_STATUSES: ["active", "quarantined", "recalled", "disposed"],
  // Statuses an admin may set directly; "disposed" is set by disposal movements.
  SETTABLE_BATCH_STATUSES: ["active", "quarantined", "recalled"],
};
