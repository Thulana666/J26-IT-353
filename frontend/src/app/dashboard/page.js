import Link from "next/link";
import { AnimatedIcon } from "@/components/icons/animated-icon";
import { ArrowRightIcon } from "@/components/icons/arrow-right";
import { CalendarDaysIcon } from "@/components/icons/calendar-days";
import { CircleCheckIcon } from "@/components/icons/circle-check";
import { ShieldCheckIcon } from "@/components/icons/shield-check";
import { requireUser } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { dashboardNav } from "@/lib/navigation";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "Dashboard | PharmaTwin",
};

// System modules shown on the main dashboard (every nav entry except this page).
const modules = dashboardNav.filter((item) => item.href !== "/dashboard");

export default async function DashboardPage() {
  const { user, profile } = await requireUser();
  const displayName = profile?.full_name || user.email;

  return (
    <>
      <PageHeader
        title={`Welcome back, ${displayName}`}
        description="PharmaTwin intelligent warehouse system."
        mock={false}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Role" value={<span className="capitalize">{profile?.role ?? "user"}</span>} icon={ShieldCheckIcon} />
        <StatCard label="Status" value={<span className="capitalize">{profile?.status ?? "active"}</span>} icon={CircleCheckIcon} />
        <StatCard
          label="Member since"
          value={formatDate(profile?.created_at ?? user.created_at)}
          icon={CalendarDaysIcon}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>Open a module to view its dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((module) => (
            <Link
              key={module.href}
              href={module.href}
              className="group flex items-start gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <AnimatedIcon icon={module.icon} />
              </span>
              <span className="flex-1 space-y-1">
                <span className="flex items-center gap-1 font-medium">
                  {module.title}
                  <AnimatedIcon icon={ArrowRightIcon} size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                <span className="block text-sm text-muted-foreground">
                  {module.description}
                </span>
              </span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
