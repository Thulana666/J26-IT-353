"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  getAiServicesStatus,
  refreshNewsPages,
  runAiServices,
} from "@/app/dashboard/medicine-impact/news/actions";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { RefreshCWIcon } from "@/components/icons/refresh-cw";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POLL_MS = 3000;
const STAGES = { starting: "Starting…", collecting: "Collecting new articles…", processing: "Analysing articles…" };

const time = (value) => (value ? new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : null);

function counts(job) {
  const parts = [
    `${job.collected} collected`,
    `${job.processed} analysed`,
    job.needsReview ? `${job.needsReview} flagged for review` : null,
    job.failed ? `${job.failed} failed (will be retried)` : null,
    job.remainingPending ? `${job.remainingPending} still pending` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

// "Run AI services": collects new articles and analyses pending ones in a
// backend background job, then polls its progress. Admins only.
export function RunAiServicesButton({ canRun }) {
  const router = useRouter();
  const [status, setStatus] = useState(null); // last /status answer
  const [message, setMessage] = useState(null); // { problem, text }
  const [starting, startTransition] = useTransition();
  const watching = useRef(false);

  const running = Boolean(status?.current) || starting;

  const poll = useCallback(async () => {
    const next = await getAiServicesStatus();
    if (!next.ok) {
      setMessage({ problem: true, text: next.error });
      return false;
    }
    setStatus(next);
    if (next.current) return true;
    if (watching.current && next.last) {
      watching.current = false;
      const job = next.last;
      const problem = job.status !== "completed";
      const outcome = { completed: "Completed", partial: "Completed with issues", failed: "Failed" }[job.status] ?? job.status;
      const names = (status) => (job.sources ?? []).filter((s) => s.status === status).map((s) => s.source);
      const failed = names("failed");
      const reason = job.error || job.stopped || job.collectionError || (failed.length ? `Failed: ${failed.join(", ")}.` : null);
      // Skipped sources (no API key, disabled, or blocked by the publisher) are expected, not errors.
      const skipped = names("skipped");
      setMessage({
        problem,
        text: `${outcome}: ${counts(job)}.${reason ? ` ${reason}` : ""}`,
        note: skipped.length ? `Skipped: ${skipped.join(", ")}.` : null,
        done: true,
      });
      await refreshNewsPages();
      router.refresh();
    }
    return false;
  }, [router]);

  // Initial status (shows a run started elsewhere, e.g. by the schedule), then poll while running.
  useEffect(() => {
    if (!canRun) return;
    let timer;
    let cancelled = false;
    const loop = async () => {
      const active = await poll();
      if (active) watching.current = true;
      if (!cancelled && active) timer = setTimeout(loop, POLL_MS);
    };
    if (!status || status.current) loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canRun, poll, status?.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () =>
    startTransition(async () => {
      setMessage(null);
      const result = await runAiServices();
      if (!result.ok && !result.alreadyRunning) {
        setMessage({ problem: true, text: result.error });
        return;
      }
      if (result.alreadyRunning) setMessage({ problem: false, text: "A run is already in progress; showing its progress." });
      watching.current = true;
      setStatus((s) => ({ ...s, current: result.job }));
    });

  const job = status?.current;
  const lastSuccess = status?.lastSuccess;

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <Button type="button" onClick={start} disabled={!canRun || running}>
        <AnimatedIcon icon={RefreshCWIcon} className={cn(running && "animate-spin")} />
        {running ? "Running…" : "Run AI services"}
      </Button>

      <div className="max-w-sm text-xs sm:text-right" role="status" aria-live="polite">
        {!canRun && <p className="text-muted-foreground">Admin access required.</p>}
        {job && (
          <p className="text-muted-foreground">
            {STAGES[job.stage] ?? "Running…"} {job.stage === "processing" && counts(job)}
          </p>
        )}
        {message && (
          <p className={message.problem ? "text-destructive" : "text-muted-foreground"}>
            {message.text}{" "}
            {message.done && (
              <Link href="/dashboard/medicine-impact/news" className="underline underline-offset-4">
                View recent news
              </Link>
            )}
          </p>
        )}
        {message?.note && <p className="text-muted-foreground">{message.note}</p>}
        {!job && lastSuccess && (
          <p className="text-muted-foreground">Last successful run: {time(lastSuccess.finishedAt)}</p>
        )}
        {status?.schedule?.enabled && (
          <p className="text-muted-foreground">
            Scheduled every {status.schedule.intervalMinutes} min; next around {time(status.schedule.nextRunAt)}.
          </p>
        )}
      </div>
    </div>
  );
}
