// Authentication and role-based access for warehouse routes. The Next.js
// server forwards the signed-in user's Supabase access token as
// "Authorization: Bearer <jwt>"; it is verified here and the user's profile
// (role, status) is loaded. Database access uses the service-role client, so
// every permission check happens in these middlewares.
//
// Roles (profiles.role, active accounts only; shared with Components 2 and 4):
//   admin            everything, including configuration and staff access
//   warehouse_staff  warehouse operations: receiving, moving, picking, dispatch,
//                    discrepancy reports and returns from pharmacies
//   pharmacy_staff   read-only medicine catalogue; no warehouse operations
//   user             no warehouse access

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");

const WAREHOUSE_ROLES = ["admin", "warehouse_staff"];
const STAFF_ROLES = ["admin", "warehouse_staff", "pharmacy_staff"];

function toUser(profile) {
  const isActive = profile.status === "active";
  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    isActive,
    isAdmin: isActive && profile.role === "admin",
    isWarehouseStaff: isActive && WAREHOUSE_ROLES.includes(profile.role),
    isStaff: isActive && STAFF_ROLES.includes(profile.role),
  };
}

async function authenticate(req, _res, next) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "Missing access token");

  // getClaims() throws, rather than returning an error, for malformed tokens.
  const { data, error } = await supabase.auth.getClaims(match[1]).catch((thrown) => ({ error: thrown }));
  const userId = data?.claims?.sub;
  if (error || !userId) throw new HttpError(401, "Session is invalid or has expired");

  const profile = unwrap(
    await supabase.from("profiles").select("id, email, full_name, role, status").eq("id", userId).maybeSingle()
  );
  if (!profile) throw new HttpError(403, "No profile exists for this user");

  req.user = toUser(profile);
  // Forwarded as-is when the warehouse hands work to another component's API.
  req.accessToken = match[1];
  next();
}

function inactive(user) {
  return new HttpError(403, user?.isActive === false ? "Your account is inactive" : "Your role does not allow this");
}

// Warehouse operations: admins and warehouse staff.
function requireWarehouseStaff(req, _res, next) {
  if (!req.user?.isWarehouseStaff) throw inactive(req.user);
  next();
}

// Read-only shared data (medicine catalogue): any active staff role.
function requireStaff(req, _res, next) {
  if (!req.user?.isStaff) throw inactive(req.user);
  next();
}

// Configuration, stock corrections, batch status, staff access: admins.
function requireAdmin(req, _res, next) {
  if (!req.user?.isAdmin) throw new HttpError(403, "Only admins can do this");
  next();
}

module.exports = {
  WAREHOUSE_ROLES,
  STAFF_ROLES,
  toUser,
  authenticate,
  requireWarehouseStaff,
  requireStaff,
  requireAdmin,
};
