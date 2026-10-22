// Errors for the pharmacy API. Reuses the warehouse HttpError and error
// handler; only the "schema missing" messages point at the pharmacy migrations.

const { HttpError, fromDbError: warehouseDbError, errorHandler } = require("../warehouse/errors");

const MIGRATIONS =
  "Apply the pharmacy migrations in supabase/migrations/ in order: 20261010000000_create_pharmacy_schema.sql, " +
  "20261010000001_create_pharmacy_functions.sql, 20261012000000_update_pharmacy_receiving.sql, " +
  "20261016000000_pharmacy_inventory_holds.sql and 20261020000000_pharmacy_linear_regression_model.sql.";

// Postgres / PostgREST error -> HttpError. The pharmacy functions raise P0001
// for business-rule violations (409, message shown to users) and P0002 for
// missing rows (404), like the warehouse ones.
// The database error code is kept on the HttpError as dbCode.
function fromDbError(error) {
  const converted = convert(error);
  converted.dbCode = error.code;
  return converted;
}

function convert(error) {
  switch (error.code) {
    case "PGRST202":
    case "42883":
      return new HttpError(500, `Pharmacy database functions are missing. ${MIGRATIONS}`, { db: error.message });
    case "PGRST205":
    case "42P01":
    case "42703":
      return new HttpError(500, `Pharmacy tables are missing or outdated. ${MIGRATIONS}`, { db: error.message });
    case "23514":
      // Check values added by later migrations (engines, model names, alert types).
      if (/pharmacy_forecast_runs_engine_check|pharmacy_demand_forecasts_model_name_check|pharmacy_alerts_alert_type_check/.test(error.message ?? "")) {
        return new HttpError(500, `Pharmacy tables are outdated. ${MIGRATIONS}`, { db: error.message });
      }
      return warehouseDbError(error);
    default:
      return warehouseDbError(error);
  }
}

function unwrap({ data, error }) {
  if (error) throw fromDbError(error);
  return data;
}

module.exports = { HttpError, fromDbError, unwrap, errorHandler };
