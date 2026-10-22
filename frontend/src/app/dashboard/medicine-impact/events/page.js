import { getDetectedEvents } from "@/lib/data";
import { RELEVANCE_LABELS, formatDate } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { LevelBadge, StatusBadge } from "@/components/dashboard/status-badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

const TYPE_LABELS = {
  disease_outbreak: "Disease outbreak",
  natural_disaster: "Natural disaster",
  supply_disruption: "Supply disruption",
  seasonal: "Seasonal",
  policy: "Policy",
  economic: "Economic",
  other: "Other",
};

const CATEGORY_LABELS = {
  public_health: "Public health",
  natural_disaster: "Natural disaster",
  pharma_supply: "Pharmaceutical supply",
  logistics: "Logistics",
  geopolitical_trade: "Geopolitical / trade",
};

export default async function EventsPage() {
  const { events, migrationMissing } = await getDetectedEvents();

  return (
    <>
      <PageHeader title={page.title} description={page.description} mock={false} />
      <Card>
        <CardHeader>
          <CardTitle>Detected events</CardTitle>
          <CardDescription>
            Grouped from analysed articles. Indirect links are possible connections, not confirmed impacts.
            Severity is not assessed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {migrationMissing
                ? "The article-analysis migration has not been applied to the database yet."
                : "No events detected yet. Analysed articles that describe a relevant event will appear here."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Locations</TableHead>
                  <TableHead>Sri Lanka relevance</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Week of</TableHead>
                  <TableHead className="text-right">Articles</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="max-w-sm whitespace-normal font-medium">
                      {event.title}
                      {event.needsReview && (
                        <div>
                          <Badge variant="outline" className="mt-1 border-amber-500/40 text-amber-500">
                            Needs review
                          </Badge>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{TYPE_LABELS[event.eventType] ?? event.eventType}</div>
                      {event.category && (
                        <div className="text-xs text-muted-foreground">{CATEGORY_LABELS[event.category] ?? event.category}</div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-48 whitespace-normal">{event.locations.join(", ") || "—"}</TableCell>
                    <TableCell>{RELEVANCE_LABELS[event.sriLankaRelevance] ?? "—"}</TableCell>
                    <TableCell>
                      {event.severity ? (
                        <LevelBadge level={event.severity} />
                      ) : (
                        <span className="text-xs text-muted-foreground">Not assessed</span>
                      )}
                    </TableCell>
                    <TableCell><StatusBadge status={event.status} /></TableCell>
                    <TableCell className="tabular-nums">{formatDate(event.startedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{event.articleCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
