// Errors for the cold-chain API. Reuses the warehouse HttpError and error
// handler, like the pharmacy module; only the "schema missing" message points
// at the cold-chain migration.

const { HttpError, fromDbError: warehouseDbError, errorHandler } = require("../warehouse/errors");

const MIGRATION =
  "Apply supabase/migrations/20261017000000_create_cold_chain_schema.sql and 20261018000002_cold_chain_logistics.sql.";

function fromDbError(error) {
  switch (error.code) {
    case "PGRST202":
    case "42883":
      return new HttpError(500, `Cold-chain database functions are missing. ${MIGRATION}`, { db: error.message });
    case "PGRST205":
    case "42P01":
    case "42703":
      return new HttpError(500, `Cold-chain tables are missing or outdated. ${MIGRATION}`, { db: error.message });
    default:
      return warehouseDbError(error);
  }
}

function unwrap({ data, error }) {
  if (error) throw fromDbError(error);
  return data;
}

module.exports = { HttpError, fromDbError, unwrap, errorHandler };
