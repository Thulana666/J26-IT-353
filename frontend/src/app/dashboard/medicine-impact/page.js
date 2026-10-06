import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { ArrowRightIcon } from "@/components/icons/arrow-right";
import { EarthIcon } from "@/components/icons/earth";
import { FileTextIcon } from "@/components/icons/file-text";
import { SyringeIcon } from "@/components/icons/syringe";
import { TrendingUpIcon } from "@/components/icons/trending-up";
import { getArticles, getEvents, getMedicineImpacts, getForecasts } from "@/lib/data";
import { formatDate } from "@/lib/format";
import { getNavItem } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { ChangeBadge, LevelBadge, StatusBadge } from "@/components/dashboard/status-badges";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
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

const page = getNavItem("/dashboard/medicine-impact");

export const metadata = {
  title: "Medicine Impact | PharmaTwin",
};

export default async function MedicineImpactOverviewPage() {
  const [events, articles, impacts, forecasts] = await Promise.all([
    getEvents(),
    // The Articles page shows load errors; here a failure just counts as 0.
    getArticles().catch((error) => {
      unstable_rethrow(error);
      console.error(error);
      return [];
    }),
    getMedicineImpacts(),
    getForecasts(),
  ]);

  const activeEvents = events.filter((e) => e.status !== "resolved");
  const highImpact = impacts.filter((i) => i.impactLevel === "high");

  return (
    <>
      <PageHeader title="Medicine Impact" description={page.description} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active events"
          value={activeEvents.length}
          hint={`${events.filter((e) => e.status === "active").length} active, ${events.filter((e) => e.status === "monitoring").length} monitoring`}
          icon={EarthIcon}
        />
        <StatCard
          label="Articles tracked"
          value={articles.length}
          hint={`From ${new Set(articles.map((a) => a.source)).size} sources`}
          icon={FileTextIcon}
        />
        <StatCard
          label="Medicines impacted"
          value={impacts.length}
          hint={`${highImpact.length} with high impact`}
          icon={SyringeIcon}
        />
        <StatCard
          label="Forecasts"
          value={forecasts.length}
          hint="Next 4 weeks (placeholder)"
          icon={TrendingUpIcon}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent events</CardTitle>
            <CardDescription>Latest events being tracked.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/dashboard/medicine-impact/events" />}>
                View all <AnimatedIcon icon={ArrowRightIcon} />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeEvents.slice(0, 5).map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>
                      <div className="font-medium">{event.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {event.region} · {formatDate(event.startedAt)}
                      </div>
                    </TableCell>
                    <TableCell><LevelBadge level={event.severity} /></TableCell>
                    <TableCell><StatusBadge status={event.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top medicine impacts</CardTitle>
            <CardDescription>Largest expected demand changes.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/dashboard/medicine-impact/analysis" />}>
                View all <AnimatedIcon icon={ArrowRightIcon} />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Medicine</TableHead>
                  <TableHead>Impact</TableHead>
                  <TableHead className="text-right">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {impacts.slice(0, 5).map((impact) => (
                  <TableRow key={impact.id}>
                    <TableCell>
                      <div className="font-medium">{impact.medicine}</div>
                      <div className="text-xs text-muted-foreground">{impact.eventTitle}</div>
                    </TableCell>
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
      </div>
    </>
  );
}
