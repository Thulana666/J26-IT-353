import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Returns the signed-in user and their profile, or redirects to /login.
// Wrapped in cache() so layouts and pages share one lookup per request.
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, status, created_at")
    .eq("id", user.id)
    .single();

  return { user, profile };
});
