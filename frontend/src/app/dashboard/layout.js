import { requireUser } from "@/lib/auth";
import { SiteHeader } from "@/components/dashboard/site-header";

export const metadata = {
  title: "Dashboard | PharmaTwin",
};

export default async function DashboardLayout({ children }) {
  const { user, profile } = await requireUser();

  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <SiteHeader profile={profile} email={user.email} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
