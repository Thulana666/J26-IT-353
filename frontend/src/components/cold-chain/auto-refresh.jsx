"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-renders the page every `seconds` while it is visible: a fallback next to
// Supabase Realtime (RealtimeRefresh) for live trips, e.g. when Realtime is
// not enabled for the project or the connection drops.
export function AutoRefresh({ seconds = 30 }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [seconds, router]);
  return null;
}
