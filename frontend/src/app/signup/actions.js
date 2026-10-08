"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const MIN_PASSWORD_LENGTH = 8;

export async function signup(_prevState, formData) {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirm_password") ?? "");
  const values = { fullName, email };

  if (!fullName || !email || !password) {
    return { error: "Please fill in all fields.", values };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      values,
    };
  }
  if (password !== confirmPassword) {
    return { error: "Passwords do not match.", values };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Picked up by the handle_new_user trigger to fill profiles.full_name.
    options: { data: { full_name: fullName } },
  });

  if (error) {
    console.error("Supabase signUp failed:", error);
    const message =
      error.name === "AuthRetryableFetchError"
        ? "Could not reach the authentication server. Please try again."
        : error.message;
    return { error: message, values };
  }

  // Email confirmation is disabled in Supabase, so signUp returns a session.
  if (!data.session) {
    return { error: "Could not sign you in. Please try signing in.", values };
  }

  redirect("/dashboard");
}
