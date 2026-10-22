"use client";

import Link from "next/link";
import { ChevronDown, CircleHelp, ExternalLink, Flag, Link2, MapPin, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NEWS_RELEVANCE_LABELS as LABELS } from "@/lib/news";
import { cn } from "@/lib/utils";

// Plain-language relevance, so a reader understands an item at a glance.
const RELEVANCE = {
  direct: { label: LABELS.direct, icon: MapPin, tile: "bg-red-500/10 text-red-600 dark:text-red-400", text: "text-red-600 dark:text-red-400" },
  indirect: { label: LABELS.indirect, icon: Link2, tile: "bg-sky-500/10 text-sky-600 dark:text-sky-400", text: "text-sky-600 dark:text-sky-400" },
  uncertain: { label: LABELS.uncertain, icon: CircleHelp, tile: "bg-muted text-muted-foreground", text: "text-muted-foreground" },
};

const CATEGORY_LABELS = {
  public_health: "Public health",
  natural_disaster: "Natural disaster",
  pharma_supply: "Pharmaceutical supply",
  logistics: "Logistics",
  geopolitical_trade: "Geopolitical / trade",
  other: "Other",
};

const DAY = 86_400_000;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// Section heading for a publication date (missing dates go last).
function dateGroup(value, now) {
  if (!value) return "Publication date unavailable";
  const date = new Date(value);
  const days = Math.round((dayStart(now) - dayStart(date)) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "Earlier this month";
  return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function relative(value, now) {
  const days = Math.round((dayStart(now) - dayStart(new Date(value))) / DAY);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const fullDate = (value) => new Date(value).toLocaleDateString("en-GB", { dateStyle: "full" });

export function NewsList({ items }) {
  const now = new Date();
  // Items arrive newest first; keep that order while grouping.
  const groups = [];
  for (const item of items) {
    const name = dateGroup(item.publishedAt, now);
    if (groups.at(-1)?.name !== name) groups.push({ name, items: [] });
    groups.at(-1).items.push(item);
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name} className="space-y-2">
          <h3 className="sticky top-0 z-10 bg-card/95 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
            {group.name}
            <span className="ml-2 font-normal normal-case">({group.items.length})</span>
          </h3>
          <ul className="divide-y rounded-lg border">
            {group.items.map((item) => (
              <NewsRow key={item.id} item={item} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function NewsRow({ item, now }) {
  const rel = RELEVANCE[item.relevance] ?? RELEVANCE.uncertain;
  const Icon = rel.icon;
  const hasDetails = item.reason || item.evidence.length > 0 || item.reviewReasons.length > 0;

  return (
    <li>
      <Collapsible className="group/row">
        <div className="flex gap-3 p-3 transition-colors hover:bg-muted/40 sm:gap-4 sm:p-4">
          <Tooltip>
            <TooltipTrigger
              render={<span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", rel.tile)} />}
            >
              <Icon className="size-4" />
              <span className="sr-only">{rel.label}</span>
            </TooltipTrigger>
            <TooltipContent>{rel.label}</TooltipContent>
          </Tooltip>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-start justify-between gap-3">
              <h4 className="line-clamp-2 leading-snug font-medium">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="hover:underline hover:underline-offset-4">
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </h4>
              {item.needsReview && (
                <Badge variant="outline" className="shrink-0 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  <Flag />
                  Review
                </Badge>
              )}
            </div>

            {/* One line a reader can scan: where, what, which event. */}
            <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
              <span className={cn("font-medium", rel.text)}>{rel.label}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{CATEGORY_LABELS[item.category] ?? "Not classified"}</span>
              {item.event && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <Link href="/dashboard/medicine-impact/events"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline">
                    <Network className="size-3.5" />
                    {item.event.title}
                  </Link>
                </>
              )}
            </p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{item.source}</span>
              {item.publishedAt ? (
                <time dateTime={item.publishedAt} title={fullDate(item.publishedAt)}>{relative(item.publishedAt, now)}</time>
              ) : (
                <span title={`Collected ${fullDate(item.collectedAt)}`}>No publication date</span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {hasDetails && (
                  <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="h-7 text-xs" />}>
                    Why?
                    <ChevronDown className="transition-transform group-data-[open]/row:rotate-180" />
                  </CollapsibleTrigger>
                )}
                {item.url && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs"
                    render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}>
                    Open
                    <ExternalLink />
                  </Button>
                )}
              </span>
            </div>

            {hasDetails && (
              <CollapsibleContent>
                <div className="mt-2 space-y-2 rounded-md bg-muted/50 p-3 text-sm">
                  {item.reason && <p>{item.reason}</p>}
                  {item.evidence.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Matched terms</span>
                      {item.evidence.map((term) => (
                        <Badge key={term} variant="outline" className="bg-background font-normal">
                          {term}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {item.reviewReasons.length > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      <span className="font-medium">Why review: </span>
                      {item.reviewReasons.join(" ")}
                    </p>
                  )}
                </div>
              </CollapsibleContent>
            )}
          </div>
        </div>
      </Collapsible>
    </li>
  );
}
