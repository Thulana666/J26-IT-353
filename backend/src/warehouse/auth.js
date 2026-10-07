// Authentication for warehouse routes. The Next.js server forwards the
// signed-in user's Supabase access token as "Authorization: Bearer <jwt>";
// it is verified here and the user's profile (role, status) is loaded.
// Database access still uses the service-role client, so role checks happen
// in these middlewares.

const supabase = require("../config/supabase");
const { HttpError, unwrap } = require("./errors");

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

  const isActive = profile.status === "active";
  req.user = {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    role: profile.role,
    isActive,
    isAdmin: isActive && profile.role === "admin",
  };
  next();
}

// Writes need an active account.
function requireActive(req, _res, next) {
  if (!req.user?.isActive) throw new HttpError(403, "Your account is inactive");
  next();
}

// Master data, stock corrections and batch status changes need an admin.
function requireAdmin(req, _res, next) {
  if (!req.user?.isAdmin) throw new HttpError(403, "Only admins can do this");
  next();
}

module.exports = { authenticate, requireActive, requireAdmin };
