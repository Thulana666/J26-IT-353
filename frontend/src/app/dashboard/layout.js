import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SiteHeader } from "@/components/dashboard/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata = {
  title: "Dashboard | PharmaTwin",
};

export default async function DashboardLayout({ children }) {
  const { user, profile } = await requireUser();
  // Drivers use the Driver Portal (Component 2), not the staff dashboard.
  if (profile?.role === "driver") redirect("/driver/dashboard");
  // Remember whether the sidebar was collapsed (cookie set by SidebarProvider).
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={sidebarOpen}>
        <AppSidebar role={profile?.status === "active" ? profile.role : null} />
        <SidebarInset>
          <SiteHeader profile={profile} email={user.email} />
          <div className="flex flex-1 flex-col gap-6 p-4 sm:p-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
