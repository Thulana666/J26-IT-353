// Small request validator: a schema maps each field to a rule; a rule returns
// the cleaned value (undefined = leave the field out) or throws FieldError.

const { HttpError } = require("./errors");
const { isISODate } = require("./dates");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class FieldError extends Error {}

const isMissing = (value) => value === undefined || value === null || value === "";

// Shared handling of required / nullable / default for every rule.
function rule(check, { required = false, nullable = false, default: fallback } = {}) {
  return (value) => {
    if (isMissing(value)) {
      if (value === null && nullable) return null;
      if (required) throw new FieldError("is required");
      return fallback;
    }
    return check(value);
  };
}

const rules = {
  uuid: (options) =>
    rule((value) => {
      if (typeof value !== "string" || !UUID_RE.test(value)) throw new FieldError("must be a valid id");
      return value.toLowerCase();
    }, options),

  string: ({ min = 1, max = 500, ...options } = {}) =>
    rule((value) => {
      if (typeof value !== "string") throw new FieldError("must be text");
      const text = value.trim();
      if (text.length < min) throw new FieldError(`must be at least ${min} characters`);
      if (text.length > max) throw new FieldError(`must be at most ${max} characters`);
      return text;
    }, options),

  // Accepts numbers and numeric strings (query parameters).
  int: ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, ...options } = {}) =>
    rule((value) => {
      const number = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (!Number.isInteger(number)) throw new FieldError("must be a whole number");
      if (number < min) throw new FieldError(`must be at least ${min}`);
      if (number > max) throw new FieldError(`must be at most ${max}`);
      return number;
    }, options),

  number: ({ min = -Infinity, max = Infinity, ...options } = {}) =>
    rule((value) => {
      const number = typeof value === "string" ? Number(value) : value;
      if (typeof number !== "number" || !Number.isFinite(number)) throw new FieldError("must be a number");
      if (number < min) throw new FieldError(`must be at least ${min}`);
      if (number > max) throw new FieldError(`must be at most ${max}`);
      return number;
    }, options),

  bool: (options) =>
    rule((value) => {
      if (value === true || value === "true") return true;
      if (value === false || value === "false") return false;
      throw new FieldError("must be true or false");
    }, options),

  oneOf: (allowed, options) =>
    rule((value) => {
      if (!allowed.includes(value)) throw new FieldError(`must be one of: ${allowed.join(", ")}`);
      return value;
    }, options),

  date: (options) =>
    rule((value) => {
      if (!isISODate(value)) throw new FieldError("must be a date (YYYY-MM-DD)");
      return value;
    }, options),
};

// Validates `source` against `schema`; throws 400 with per-field messages.
function validate(source, schema) {
  const values = {};
  const fields = {};
  for (const [key, check] of Object.entries(schema)) {
    try {
      const value = check(source?.[key]);
      if (value !== undefined) values[key] = value;
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      fields[key] = error.message;
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new HttpError(400, "Invalid request", { fields });
  }
  return values;
}

// Throws a 400 for one field (cross-field checks after validate()).
function fieldError(field, message) {
  return new HttpError(400, "Invalid request", { fields: { [field]: message } });
}

// { camelCaseField: value } -> { db_column: value } for the fields present.
function toColumns(values, columns) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([field]) => field in columns)
      .map(([field, value]) => [columns[field], value])
  );
}

module.exports = { rules, validate, fieldError, toColumns, UUID_RE };
