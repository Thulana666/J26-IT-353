import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const page = getNavItem("/dashboard/medicine-impact/articles");
const ROWS = 6;

// Shown by Next.js while the articles query runs.
export default function ArticlesLoading() {
  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false} />
      <Card aria-busy="true" aria-label="Loading articles">
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: ROWS }, (_, index) => (
            <div key={index} className="flex items-center gap-4">
              <Skeleton className="h-4 flex-[3]" />
              <Skeleton className="h-4 flex-[1.5]" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
