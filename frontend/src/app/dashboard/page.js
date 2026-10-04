import { CalendarDays, CircleCheck, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function DashboardPage() {
  const { user, profile } = await requireUser();
  const displayName = profile?.full_name || user.email;

  const stats = [
    { label: "Role", value: profile?.role ?? "user", icon: ShieldCheck },
    { label: "Status", value: profile?.status ?? "active", icon: CircleCheck },
    {
      label: "Member since",
      value: new Date(profile?.created_at ?? user.created_at).toLocaleDateString(
        "en-US",
        { year: "numeric", month: "short", day: "numeric" }
      ),
      icon: CalendarDays,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {displayName}
        </h1>
        <p className="text-muted-foreground">
          Here&apos;s an overview of your account.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardHeader>
              <CardDescription className="flex items-center gap-2">
                <Icon className="size-4" />
                {label}
              </CardDescription>
              <CardTitle className="text-xl capitalize">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Getting started</CardTitle>
          <CardDescription>
            Dashboard modules will appear here as they are added.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          You are signed in as {user.email}.
        </CardContent>
      </Card>
    </div>
  );
}
