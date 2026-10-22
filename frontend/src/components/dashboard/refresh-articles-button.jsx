"use client";

import { useActionState, useEffect, useState } from "react";
import { analyseArticles, refreshArticles } from "@/app/dashboard/medicine-impact/articles/actions";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MESSAGE_SECONDS = 5;

// One-line summary of an analysis run (returned by both actions).
function analysisNote(a) {
  if (!a) return null;
  if (a.error) return { problem: true, text: `Analysis failed: ${a.error}` };
  const text = `Analysed ${a.processed} article${a.processed === 1 ? "" : "s"}` +
    (a.needsReview ? `, ${a.needsReview} need review` : "") + (a.failed ? `, ${a.failed} failed` : "") + ".";
  // Paused analysis is not a data error: articles stay pending and are analysed next time.
  return a.stopped ? { problem: true, text: `Analysis paused. ${a.stopped} Articles stay pending.` } : { problem: a.failed > 0, text };
}

// Runs the article collector (which then analyses a first batch) or the NLP
// analysis alone. A short success note fades after a few seconds; failures
// (a source failing, backend or AI service unreachable) stay visible.
export function RefreshArticlesButton({ canRefresh }) {
  const [result, formAction, isPending] = useActionState(
    (_previous, formData) => (formData.get("task") === "analyse" ? analyseArticles() : refreshArticles()),
    null
  );
  const [task, setTask] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const isCollecting = isPending && task === "collect";
  const isAnalysing = isPending && task === "analyse";

  const failures = result?.results?.filter((r) => r.status === "failed") ?? [];
  const note = analysisNote(result?.analysis);
  const hasProblem = result && (!result.ok || failures.length > 0 || note?.problem);

  // Hide the success note after a few seconds (failures are kept).
  useEffect(() => {
    if (!result || hasProblem) return;
    const timer = setTimeout(() => setDismissed(result), MESSAGE_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [result, hasProblem]);

  const showResult = !isPending && result && dismissed !== result;

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex gap-2">
        <form action={formAction} onSubmit={() => setTask("analyse")}>
          <input type="hidden" name="task" value="analyse" />
          <Button type="submit" variant="outline" disabled={!canRefresh || isPending}>
            {isAnalysing ? "Analysing…" : "Analyse pending"}
          </Button>
        </form>
        <form action={formAction} onSubmit={() => setTask("collect")}>
          <input type="hidden" name="task" value="collect" />
          <Button type="submit" variant="outline" disabled={!canRefresh || isPending}>
            <AnimatedIcon icon={RefreshCWIcon} className={cn(isCollecting && "animate-spin")} />
            {isCollecting ? "Collecting articles…" : "Refresh"}
          </Button>
        </form>
      </div>

      {!canRefresh && <p className="text-xs text-muted-foreground">Only admins can collect or analyse articles.</p>}

      {showResult && (
        <div className="max-w-sm text-xs sm:text-right" role="status">
          {!result.ok ? (
            <p className="text-destructive">{result.error}</p>
          ) : (
            result.inserted !== undefined && (
              <p className="text-muted-foreground">
                {result.inserted > 0
                  ? `${result.inserted} new article${result.inserted === 1 ? "" : "s"} collected.`
                  : "No new articles."}
              </p>
            )
          )}
          {result.ok && note && <p className={note.problem ? "text-destructive" : "text-muted-foreground"}>{note.text}</p>}
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
