import { getDemand } from "@/lib/data";
import { formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { ChangeBadge } from "@/components/dashboard/status-badges";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/demand");

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function DemandPage() {
  const rows = await getDemand();

  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Medicine</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead className="text-right">Monthly baseline</TableHead>
                <TableHead className="text-right">Last 30 days</TableHead>
                <TableHead className="text-right">Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.medicine}</TableCell>
                  <TableCell className="text-muted-foreground">{row.unit}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.baseline)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.last30Days)}</TableCell>
                  <TableCell className="text-right">
                    <ChangeBadge value={row.changePct} />
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
