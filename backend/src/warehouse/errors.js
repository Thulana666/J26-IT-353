// HTTP errors for the warehouse API, and mapping of Supabase/Postgres errors.

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Postgres / PostgREST error -> HttpError.
// record_inventory_movement() raises P0001 for business-rule violations and
// P0002 for missing rows; those messages are meant for users.
function fromDbError(error) {
  switch (error.code) {
    case "P0001":
      return new HttpError(409, error.message);
    case "P0002":
    case "PGRST116":
      return new HttpError(404, error.code === "P0002" ? error.message : "Not found");
    case "23505":
      return new HttpError(409, "A record with these values already exists", { db: error.details });
    case "23503":
      return new HttpError(409, "A referenced record does not exist or is still in use", { db: error.details });
    case "23514":
    case "22P02":
    case "22007":
    case "22008":
      return new HttpError(400, "A value is not allowed", { db: error.message });
    case "42501":
      return new HttpError(500, `Database permission missing: ${error.message}. ${error.hint ?? ""}`.trim(), {
        db: error.message,
      });
    case "PGRST205":
    case "42P01":
      return new HttpError(
        500,
        "Warehouse tables are missing. Apply supabase/migrations/20261008000000_create_warehouse_schema.sql.",
        { db: error.message }
      );
    default:
      return new HttpError(500, "Database error", { db: error.message });
  }
}

// Returns `data` from a Supabase response, or throws its error as an HttpError.
function unwrap({ data, error }) {
  if (error) throw fromDbError(error);
  return data;
}

// Router-level error handler: JSON responses for every warehouse route.
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(`[warehouse] ${req.method} ${req.originalUrl}: ${err.message}`, err.details ?? "");
    return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body is not valid JSON" });
  }
  console.error(`[warehouse] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: "Internal server error" });
}

module.exports = { HttpError, fromDbError, unwrap, errorHandler };
