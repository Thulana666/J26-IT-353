// Request validation for inventory movements. Stock, capacity and storage
// compatibility are enforced again, atomically, by the database function
// record_inventory_movement(); this gives early, field-level messages.

const { HttpError } = require("./errors");
const { rules, validate } = require("./validation");

const MOVEMENT_TYPES = ["receive", "transfer", "dispatch", "adjustment", "disposal"];
// Stock corrections and write-offs need an admin.
const ADMIN_ONLY_MOVEMENTS = ["adjustment", "disposal"];

// Which locations each type needs (adjustment: exactly one of the two).
const LOCATIONS = {
  receive: { from: false, to: true },
  transfer: { from: true, to: true },
  dispatch: { from: true, to: false },
  disposal: { from: true, to: false },
};

const movementSchema = {
  batchId: rules.uuid({ required: true }),
  movementType: rules.oneOf(MOVEMENT_TYPES, { required: true }),
  quantity: rules.int({ required: true, min: 1, max: 1_000_000 }),
  fromLocationId: rules.uuid(),
  toLocationId: rules.uuid(),
  // 'system' is reserved for backend jobs.
  performedVia: rules.oneOf(["manual", "qr_scan"], { default: "manual" }),
  reference: rules.string({ max: 120 }),
  notes: rules.string({ max: 1000 }),
  fefoOverrideReason: rules.string({ min: 10, max: 500 }),
};

function validateMovementInput(body) {
  const values = validate(body, movementSchema);
  const { movementType: type, fromLocationId: from, toLocationId: to } = values;
  const fields = {};

  if (type === "adjustment") {
    if (Boolean(from) === Boolean(to)) {
      fields.fromLocationId = "Give either a source location (stock decrease) or a destination (stock increase)";
    }
  } else {
    const needs = LOCATIONS[type];
    if (needs.from && !from) fields.fromLocationId = `is required for a ${type}`;
    if (!needs.from && from) fields.fromLocationId = `must be empty for a ${type}`;
    if (needs.to && !to) fields.toLocationId = `is required for a ${type}`;
    if (!needs.to && to) fields.toLocationId = `must be empty for a ${type}`;
  }
  if (type === "transfer" && from && to && from === to) {
    fields.toLocationId = "must be different from the source location";
  }
  if (ADMIN_ONLY_MOVEMENTS.includes(type) && !values.notes) {
    fields.notes = `A reason is required for a ${type}`;
  }
  if (values.fefoOverrideReason && type !== "dispatch") {
    fields.fefoOverrideReason = "only applies to dispatches";
  }

  if (Object.keys(fields).length > 0) throw new HttpError(400, "Invalid request", { fields });
  return values;
}

module.exports = { MOVEMENT_TYPES, ADMIN_ONLY_MOVEMENTS, validateMovementInput };
