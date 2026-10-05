import { AnimatedIcon } from "@/components/icons/animated-icon";
import { FlaskIcon } from "@/components/icons/flask";
import { getForecasts } from "@/lib/data";
import { formatNumber } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { ChangeBadge } from "@/components/dashboard/status-badges";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/forecasts");
const WEEKS = ["Week 1", "Week 2", "Week 3", "Week 4"];

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function ForecastsPage() {
  const rows = await getForecasts();

  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Alert>
        <AnimatedIcon icon={FlaskIcon} className="translate-y-0.5" />
        <AlertDescription>
          The forecasting model is not implemented yet. Values below are
          placeholders to show the layout.
        </AlertDescription>
      </Alert>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Medicine</TableHead>
                <TableHead className="text-right">Weekly baseline</TableHead>
                {WEEKS.map((week) => (
                  <TableHead key={week} className="text-right">{week}</TableHead>
                ))}
                <TableHead className="text-right">vs baseline</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="font-medium">{row.medicine}</div>
                    <div className="text-xs text-muted-foreground">{row.unit}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatNumber(row.weeklyBaseline)}
                  </TableCell>
                  {row.weeks.map((value, index) => (
                    <TableCell key={WEEKS[index]} className="text-right tabular-nums">
                      {formatNumber(value)}
                    </TableCell>
                  ))}
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
