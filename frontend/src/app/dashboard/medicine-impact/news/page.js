import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Clock, Layers, Newspaper, SearchX } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getNewsFreshness, getNewsSources, getNewsSummary, getRecentNews } from "@/lib/data";
import { NEWS_CATEGORIES, NEWS_RELEVANCE, NEWS_RELEVANCE_LABELS, filterParams, parseNewsFilters } from "@/lib/news";
import { getNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { PageHeader } from "@/components/dashboard/page-header";
import { PagePagination } from "@/components/dashboard/page-pagination";
import { NewsFilters } from "@/components/dashboard/news-filters";
import { NewsList } from "@/components/dashboard/news-list";
import { RunAiServicesButton } from "@/components/dashboard/run-ai-services-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const page = getNavItem("/dashboard/medicine-impact/news");
const BASE_PATH = "/dashboard/medicine-impact/news";

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

const CATEGORY_LABELS = {
  public_health: "Public health",
  natural_disaster: "Natural disaster",
  pharma_supply: "Pharmaceutical supply",
  logistics: "Logistics",
  geopolitical_trade: "Geopolitical / trade",
  other: "Other",
};

const SUMMARY_DOTS = { direct: "bg-red-500", indirect: "bg-sky-500", uncertain: "bg-muted-foreground/60" };

const formatDateTime = (value) =>
  new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Colombo" });

export default async function RecentNewsPage({ searchParams }) {
  const { profile } = await requireUser();
  const canRun = profile?.role === "admin" && profile?.status === "active";
  const filters = parseNewsFilters(await searchParams);
  const active = filterParams(filters);
  const filtered = Object.keys(active).length > 0;

  let result = null;
  let sources = [];
  let freshness = null;
  let summary = null;
  let loadError = null;
  try {
    [result, sources, freshness, summary] = await Promise.all([
      getRecentNews(filters),
      getNewsSources(),
      getNewsFreshness(),
      getNewsSummary(),
    ]);
  } catch (error) {
    // Let Next.js handle its own control-flow errors (redirects, dynamic rendering).
    unstable_rethrow(error);
    console.error(error);
    loadError = error.message;
  }

  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false}>
        <RunAiServicesButton canRun={canRun} />
      </PageHeader>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label={NEWS_RELEVANCE_LABELS.direct} value={summary.direct} dot={SUMMARY_DOTS.direct}
            href={`${BASE_PATH}?relevance=direct`} />
          <SummaryCard label={NEWS_RELEVANCE_LABELS.indirect} value={summary.indirect} dot={SUMMARY_DOTS.indirect}
            href={`${BASE_PATH}?relevance=indirect`} />
          <SummaryCard label={NEWS_RELEVANCE_LABELS.uncertain} value={summary.uncertain} dot={SUMMARY_DOTS.uncertain}
            href={`${BASE_PATH}?relevance=uncertain`} />
          <SummaryCard label="Needs human review" value={summary.review} dot="bg-amber-500" href={`${BASE_PATH}?review=yes`} />
        </div>
      )}

      {freshness && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-3.5" />
            Last collected {freshness.lastCollectedAt ? formatDateTime(freshness.lastCollectedAt) : "never"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Layers className="size-3.5" />
            Last analysed {freshness.lastAnalysedAt ? formatDateTime(freshness.lastAnalysedAt) : "never"}
          </span>
          <span>{freshness.pending} awaiting analysis</span>
          <span className="ml-auto">Times in Sri Lanka time</span>
        </div>
      )}

      <NewsFilters
        values={filters}
        filters={[
          { name: "category", label: "Category", plural: "categories", options: NEWS_CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]]) },
          { name: "relevance", label: "Relevance", plural: "relevance", options: NEWS_RELEVANCE.map((r) => [r, NEWS_RELEVANCE_LABELS[r]]) },
          { name: "source", label: "Source", plural: "sources", options: sources.map((s) => [s.id, s.name]) },
          { name: "review", label: "Review", plural: "review states", options: [["yes", "Needs review"], ["no", "No review flag"]] },
        ]}
      />

      {loadError ? (
        <Alert variant="destructive">
          <AnimatedIcon icon={BadgeAlertIcon} className="row-span-2 translate-y-0.5" />
          <AlertTitle>News could not be loaded</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : result.items.length === 0 ? (
        <EmptyState filtered={filtered} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {result.total.toLocaleString()} article{result.total === 1 ? "" : "s"}
              {filtered && " found"}
            </CardTitle>
            <CardDescription>
              Newest first. Classifications are model predictions and do not confirm an impact on medicine demand.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <NewsList items={result.items} />
            <PagePagination page={result.page} pageCount={result.pageCount} basePath={BASE_PATH} params={active} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function SummaryCard({ label, value, dot, href }) {
  return (
    <Link href={href} className="group">
      <Card className="transition-colors group-hover:bg-muted/40">
        <CardContent className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
            {label}
          </div>
          <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EmptyState({ filtered }) {
  const Icon = filtered ? SearchX : Newspaper;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </span>
        <div className="space-y-1">
          <p className="font-medium">{filtered ? "No matching articles" : "No analysed news yet"}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {filtered
              ? "Try a broader search or clear some filters."
              : "Click Run AI services to collect and analyse articles with a possible Sri Lankan connection."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
