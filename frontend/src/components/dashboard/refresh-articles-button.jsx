"use client";

import { useActionState, useEffect, useState } from "react";
import { refreshArticles } from "@/app/dashboard/medicine-impact/articles/actions";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MESSAGE_SECONDS = 5;

// Runs the article collector. A short success note fades after a few seconds;
// failures (a source failing, backend unreachable) stay visible.
export function RefreshArticlesButton({ canRefresh }) {
  const [result, formAction, isPending] = useActionState(() => refreshArticles(), null);
  const [dismissed, setDismissed] = useState(null);

  const failures = result?.results?.filter((r) => r.status === "failed") ?? [];
  const hasProblem = result && (!result.ok || failures.length > 0);

  // Hide the success note after a few seconds (failures are kept).
  useEffect(() => {
    if (!result || hasProblem) return;
    const timer = setTimeout(() => setDismissed(result), MESSAGE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [result, hasProblem]);

  const showResult = !isPending && result && dismissed !== result;

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <form action={formAction}>
        <Button type="submit" variant="outline" disabled={!canRefresh || isPending}>
          <AnimatedIcon icon={RefreshCWIcon} className={cn(isPending && "animate-spin")} />
          {isPending ? "Collecting articles…" : "Refresh"}
        </Button>
      </form>

      {!canRefresh && <p className="text-xs text-muted-foreground">Only admins can collect articles.</p>}

      {showResult && (
        <div className="max-w-sm text-xs sm:text-right" role="status">
          {!result.ok ? (
            <p className="text-destructive">{result.error}</p>
          ) : (
            <p className="text-muted-foreground">
              {result.inserted > 0
                ? `${result.inserted} new article${result.inserted === 1 ? "" : "s"} collected.`
                : "No new articles."}
            </p>
          )}
          {failures.map((r) => (
            <p key={r.source} className="text-destructive">
              {r.source} failed{r.error ? `: ${r.error}` : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
