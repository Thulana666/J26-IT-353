import { getEvents } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { LevelBadge, StatusBadge } from "@/components/dashboard/status-badges";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const page = getNavItem("/dashboard/medicine-impact/events");

export const metadata = {
  title: `${page.title} | PharmaTwin`,
};

export default async function EventsPage() {
  const events = await getEvents();

  return (
    <>
      <PageHeader title={page.title} description={page.description} />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Articles</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-medium">{event.title}</TableCell>
                  <TableCell>{event.type}</TableCell>
                  <TableCell>{event.region}</TableCell>
                  <TableCell><LevelBadge level={event.severity} /></TableCell>
                  <TableCell><StatusBadge status={event.status} /></TableCell>
                  <TableCell>{formatDate(event.startedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{event.articleCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
