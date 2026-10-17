// Authentication and role-based access for the pharmacy API.
//
// The Next.js server forwards the user's Supabase access token
// ("Authorization: Bearer <jwt>") and, for admins, the pharmacy they are
// working in ("X-Pharmacy-Id"). The token is verified here and the profile is
// loaded; database access uses the service-role client, so every permission
// check happens in these middlewares and in the routes.
//
// Roles (profiles.role, active accounts only):
//   admin            everything, in any pharmacy
//   pharmacy_staff   their own pharmacy (profiles.pharmacy_id)
//   warehouse_staff  order fulfilment, discrepancy reports and returns
//   user             no pharmacy access

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");
const { UUID_RE } = require("../warehouse/validation");

async function authenticate(req, _res, next) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "Missing access token");

  // getClaims() throws, rather than returning an error, for malformed tokens.
  const { data, error } = await supabase.auth.getClaims(match[1]).catch((thrown) => ({ error: thrown }));
  const userId = data?.claims?.sub;
  if (error || !userId) throw new HttpError(401, "Session is invalid or has expired");

  const profile = unwrap(
    await supabase
      .from("profiles")
      .select("id, email, full_name, role, status, pharmacy_id")
      .eq("id", userId)
      .maybeSingle()
  );
  if (!profile) throw new HttpError(403, "No profile exists for this user");

  const isActive = profile.status === "active";
  req.user = {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    pharmacyId: profile.pharmacy_id,
    isActive,
    isAdmin: isActive && profile.role === "admin",
    isPharmacyStaff: isActive && profile.role === "pharmacy_staff",
    isWarehouseStaff: isActive && profile.role === "warehouse_staff",
  };
  next();
}

// Allows active accounts with one of the roles; admins are always allowed.
function requireRole(...roles) {
  return (req, _res, next) => {
    const { user } = req;
    if (!user?.isActive) throw new HttpError(403, "Your account is inactive");
    if (!user.isAdmin && !roles.includes(user.role)) {
      throw new HttpError(403, "Your role does not allow this");
    }
    next();
  };
}

const requireAdmin = requireRole();
const requirePharmacyStaff = requireRole("pharmacy_staff");
const requireWarehouseStaff = requireRole("warehouse_staff");
const requireAnyStaff = requireRole("pharmacy_staff", "warehouse_staff");

const PHARMACY_SELECT =
  "id, code, name, warehouse_id, location_id, address, phone, license_number, default_lead_time_days, " +
  "default_review_period_days, default_service_level, burn_rate_window_days, near_expiry_days, " +
  "tax_rate_percent, max_discount_percent, currency, is_active, created_at, updated_at";

// Sets req.pharmacy for routes that work inside one pharmacy:
// pharmacy staff always get their own; admins get the pharmacy they chose
// (X-Pharmacy-Id), else their default, else the first active pharmacy.
async function pharmacyScope(req, _res, next) {
  const { user } = req;
  const requested = req.get("x-pharmacy-id") || undefined;
  if (requested && !UUID_RE.test(requested)) throw new HttpError(400, "X-Pharmacy-Id is not a valid id");

  let pharmacyId;
  if (user.isPharmacyStaff) {
    if (!user.pharmacyId) {
      throw new HttpError(403, "Your account is not linked to a pharmacy. Ask an admin to assign one in Settings.");
    }
    // The header is ignored: staff always work in their own pharmacy.
    pharmacyId = user.pharmacyId;
  } else if (user.isAdmin) {
    pharmacyId = requested ?? user.pharmacyId;
  } else {
    throw new HttpError(403, "Only pharmacy staff and admins can use this");
  }

  let query = supabase.from("pharmacies").select(PHARMACY_SELECT);
  query = pharmacyId ? query.eq("id", pharmacyId) : query.eq("is_active", true).order("name").limit(1);
  const pharmacy = unwrap(await query.maybeSingle());
  if (!pharmacy) {
    throw new HttpError(
      pharmacyId ? 404 : 409,
      pharmacyId ? "Pharmacy not found" : "No pharmacy exists yet. An admin can create one in Settings."
    );
  }
  req.pharmacy = pharmacy;
  next();
}

// For lists shared with the warehouse (orders, shipments, discrepancies,
// returns): which pharmacy ids may the user see? null = all.
function visiblePharmacyIds(req) {
  const { user } = req;
  if (user.isPharmacyStaff) return user.pharmacyId ? [user.pharmacyId] : [];
  if (user.isWarehouseStaff || user.isAdmin) return null;
  return [];
}

// Throws 404 unless the user may see records of this pharmacy.
function assertCanSee(req, pharmacyId, what = "Record") {
  const ids = visiblePharmacyIds(req);
  if (ids !== null && !ids.includes(pharmacyId)) throw new HttpError(404, `${what} not found`);
}

module.exports = {
  authenticate,
  requireRole,
  requireAdmin,
  requirePharmacyStaff,
  requireWarehouseStaff,
  requireAnyStaff,
  pharmacyScope,
  visiblePharmacyIds,
  assertCanSee,
  PHARMACY_SELECT,
};
