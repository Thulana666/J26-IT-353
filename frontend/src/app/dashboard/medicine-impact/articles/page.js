import { getArticles } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { LevelBadge } from "@/components/dashboard/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/articles");

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function ArticlesPage() {
  const articles = await getArticles();

  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Linked event</TableHead>
                <TableHead>Relevance</TableHead>
                <TableHead>Published</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {articles.map((article) => (
                <TableRow key={article.id}>
                  <TableCell className="font-medium">{article.title}</TableCell>
                  <TableCell>{article.source}</TableCell>
                  <TableCell><Badge variant="outline">{article.sourceType}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{article.eventTitle}</TableCell>
                  <TableCell><LevelBadge level={article.relevance} /></TableCell>
                  <TableCell>{formatDate(article.publishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
