"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UUID_RE, coldChainApi } from "@/lib/cold-chain/api";
import { createClient } from "@/lib/supabase/server";
import { WarehouseApiError } from "@/lib/warehouse/api";

// Server actions of the Driver Portal (Component 2). Sign-in uses the
// existing Supabase accounts; the backend checks on every request that the
// account is a driver and that the delivery is theirs.

const ISSUE_FIELD_LABELS = { issueType: "Issue type", description: "Description", notes: "Note" };

function failure(error) {
  if (!(error instanceof WarehouseApiError)) throw error;
  const fields = error.details?.fields
    ? Object.fromEntries(Object.entries(error.details.fields).map(([key, message]) => [ISSUE_FIELD_LABELS[key] ?? key, message]))
    : null;
  return { ok: false, error: error.message, fields };
}

export async function driverLogin(_previous, formData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Please enter your email and password.", email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.name === "AuthRetryableFetchError") {
      return { error: "Could not reach the sign-in server. Check your connection and try again.", email };
    }
    return { error: "Invalid email or password.", email };
  }

  const { data: profile } = await supabase.from("profiles").select("role, status").eq("id", data.user.id).single();
  if (profile?.status !== "active") {
    await supabase.auth.signOut();
    return { error: "Your account is inactive. Please contact the warehouse.", email };
  }
  // Staff who sign in here go to their usual dashboard.
  redirect(profile.role === "driver" ? "/driver/dashboard" : "/dashboard");
}

export async function driverLogout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/driver/login");
}

export async function confirmDeliveryAction(_previous, formData) {
  const shipmentId = formData.get("shipmentId");
  if (typeof shipmentId !== "string" || !UUID_RE.test(shipmentId)) return { ok: false, error: "Unknown delivery." };
  const notes = String(formData.get("notes") ?? "").trim();
  try {
    await coldChainApi(`/driver/deliveries/${shipmentId}/deliver`, { method: "POST", body: notes ? { notes } : {} });
  } catch (error) {
    return failure(error);
  }
  revalidatePath("/driver", "layout");
  return { ok: true, message: "Delivery completed successfully." };
}

export async function reportIssueAction(_previous, formData) {
  const shipmentId = formData.get("shipmentId");
  if (typeof shipmentId !== "string" || !UUID_RE.test(shipmentId)) return { ok: false, error: "Unknown delivery." };
  try {
    await coldChainApi(`/driver/deliveries/${shipmentId}/issues`, {
      method: "POST",
      body: { issueType: String(formData.get("issueType") ?? ""), description: String(formData.get("description") ?? "").trim() },
    });
  } catch (error) {
    return failure(error);
  }
  revalidatePath(`/driver/deliveries/${shipmentId}`);
  return { ok: true, message: "Issue reported. The warehouse can see it now." };
}
