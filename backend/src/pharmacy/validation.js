// Request validation with Zod (nested item arrays need more than the
// warehouse's flat validator). Errors use the same shape as the rest of the
// API: 400 { error: "Invalid request", details: { fields: { path: message } } }.

const { z } = require("zod");
const { HttpError } = require("./errors");
const { isISODate } = require("../warehouse/dates");

function parse(schema, source) {
  const result = schema.safeParse(source ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "body";
    fields[key] ??= issue.message;
  }
  throw new HttpError(400, "Invalid request", { fields });
}

// Accepts numbers and numeric strings (form fields, query parameters).
const int = (min = 0, max = 1_000_000) =>
  z.coerce
    .number({ invalid_type_error: "must be a number" })
    .int("must be a whole number")
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`);

const num = (min = 0, max = 1_000_000_000) =>
  z.coerce.number({ invalid_type_error: "must be a number" }).min(min, `must be at least ${min}`).max(max, `must be at most ${max}`);

const id = z.string().uuid("must be a valid id");

// Optional text: trimmed, empty -> undefined.
const text = (max = 500) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max, `must be at most ${max} characters`).optional()
  );

const requiredText = (max = 500) => z.string({ invalid_type_error: "is required" }).trim().min(1, "is required").max(max);

// Optional values that may arrive as "" from forms.
const optional = (schema) => z.preprocess((value) => (value === "" || value === null ? undefined : value), schema.optional());

// null clears a setting; "" from a form also clears it.
const nullable = (schema) => z.preprocess((value) => (value === "" ? null : value), schema.nullable().optional());

const isoDate = z.string().refine(isISODate, "must be a date (YYYY-MM-DD)");

const bool = z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean());

module.exports = { z, parse, int, num, id, text, requiredText, optional, nullable, isoDate, bool };
