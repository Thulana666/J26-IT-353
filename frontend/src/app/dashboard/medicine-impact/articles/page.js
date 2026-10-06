import { unstable_rethrow } from "next/navigation";
import { ARTICLE_LIMIT, getArticles } from "@/lib/data";
import { formatCountry, formatDate, formatLanguage } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { BadgeAlertIcon } from "@/components/icons/badge-alert";
import { FileTextIcon } from "@/components/icons/file-text";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badges";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/articles");

const SOURCE_TYPE_LABELS = {
  news: "News",
  government: "Government",
  international: "International",
  social_media: "Social media",
  other: "Other",
};

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

// Several reports can share a title (e.g. WHO updates on the same outbreak).
// Show only the newest of each; the database keeps them all for event analysis.
function latestPerTitle(articles) {
  const seen = new Set();
  return articles.filter((article) => {
    const key = article.title.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function ArticlesPage() {
  let allArticles = [];
  let loadError = null;
  try {
    allArticles = await getArticles();
  } catch (error) {
    // Let Next.js handle its own control-flow errors (redirects, dynamic rendering).
    unstable_rethrow(error);
    console.error(error);
    loadError = error.message;
  }
  // getArticles() returns newest first, so the first of each title is the latest.
  const articles = latestPerTitle(allArticles);
  const hiddenCount = allArticles.length - articles.length;

  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false} />

      {loadError ? (
        <Alert variant="destructive">
          <AnimatedIcon icon={BadgeAlertIcon} className="row-span-2 translate-y-0.5" />
          <AlertTitle>Articles could not be loaded</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : articles.length === 0 ? (
        <EmptyState />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Collected articles</CardTitle>
            <CardDescription>
              {allArticles.length === ARTICLE_LIMIT
                ? `From the ${ARTICLE_LIMIT} most recent articles`
                : `${articles.length} article${articles.length === 1 ? "" : "s"}, newest first`}
              {hiddenCount > 0 &&
                ` (${hiddenCount} older report${hiddenCount === 1 ? "" : "s"} with the same title hidden)`}
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {articles.map((article) => (
                  <TableRow key={article.id}>
                    <TableCell className="max-w-md whitespace-normal">
                      {article.url ? (
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {article.title}
                        </a>
                      ) : (
                        <span className="font-medium">{article.title}</span>
                      )}
                      {article.eventTitle && (
                        <div className="text-xs text-muted-foreground">
                          Event: {article.eventTitle}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{article.source ?? "Unknown source"}</div>
                      {article.sourceType && (
                        <div className="text-xs text-muted-foreground">
                          {SOURCE_TYPE_LABELS[article.sourceType] ?? article.sourceType}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{formatCountry(article.countryCode) ?? "—"}</TableCell>
                    <TableCell>{formatLanguage(article.language) ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">
                      {article.publishedAt ? formatDate(article.publishedAt) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={article.processingStatus} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function EmptyState() {
  return (
    <Card data-animate-icon>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <AnimatedIcon icon={FileTextIcon} size={22} />
        </span>
        <div className="space-y-1">
          <p className="font-medium">No articles yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Articles collected from news, health-alert and crisis sources will
            appear here.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
