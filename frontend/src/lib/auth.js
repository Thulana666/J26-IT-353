import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Returns the signed-in user and their profile, or redirects to /login.
// Wrapped in cache() so layouts and pages share one lookup per request.
//
// Uses getClaims(), the same check as the proxy (src/lib/supabase/proxy.js).
// If the two disagreed (e.g. getUser() here while the proxy uses getClaims()),
// a revoked-but-unexpired session would bounce between /dashboard and /login.
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims) redirect("/login");

  const user = { id: claims.sub, email: claims.email };

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, status, created_at")
    .eq("id", user.id)
    .single();

  return { user, profile };
});
