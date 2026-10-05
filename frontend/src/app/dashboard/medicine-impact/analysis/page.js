import { getMedicineImpacts } from "@/lib/data";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { ChangeBadge, LevelBadge } from "@/components/dashboard/status-badges";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/analysis");

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function ImpactAnalysisPage() {
  const impacts = await getMedicineImpacts();

  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Medicine</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Driving event</TableHead>
                <TableHead>Impact</TableHead>
                <TableHead className="text-right">Expected change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {impacts.map((impact) => (
                <TableRow key={impact.id}>
                  <TableCell className="font-medium">{impact.medicine}</TableCell>
                  <TableCell>{impact.category}</TableCell>
                  <TableCell className="text-muted-foreground">{impact.eventTitle}</TableCell>
                  <TableCell><LevelBadge level={impact.impactLevel} /></TableCell>
                  <TableCell className="text-right">
                    <ChangeBadge value={impact.expectedChangePct} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
