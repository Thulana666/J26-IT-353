import { DashboardBreadcrumb } from "@/components/dashboard/dashboard-breadcrumb";
import { UserMenu } from "@/components/dashboard/user-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

export function SiteHeader({ profile, email }) {
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4 self-center" />
      <DashboardBreadcrumb />
      <div className="ml-auto">
        <UserMenu
          name={profile?.full_name}
          email={profile?.email ?? email}
          role={profile?.role ?? "user"}
        />
      </div>
    </header>
  );
}
