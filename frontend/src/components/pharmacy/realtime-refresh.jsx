"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Re-renders the page when rows of the given tables change (Supabase
// Realtime). Row level security applies, so a user only hears about rows
// they may read. filter: e.g. "pharmacy_id=eq.<id>".
export function RealtimeRefresh({ tables, filter }) {
  const router = useRouter();
  const key = tables.join(",");

  useEffect(() => {
    const supabase = createClient();
    let timer;
    const channel = supabase.channel(`pharmacy:${key}:${filter ?? "all"}`);
    for (const table of key.split(",")) {
      channel.on("postgres_changes", { event: "*", schema: "public", table, ...(filter && { filter }) }, () => {
        clearTimeout(timer);
        // Several rows change in one transaction: refresh once.
        timer = setTimeout(() => router.refresh(), 500);
      });
    }
    channel.subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [key, filter, router]);

  return null;
}
