import Link from "next/link";
import { redirect } from "next/navigation";
import { driverLogout } from "@/app/driver/actions";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Driver Portal | PharmaTwin" };

// The Driver Portal (Component 2): a phone-first shell without the staff
// sidebar. Only active driver accounts get here; the backend checks again on
// every request which deliveries belong to the driver.
export default async function DriverPortalLayout({ children }) {
  const { profile } = await requireUser();
  if (profile?.role !== "driver" || profile.status !== "active") redirect("/dashboard");

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b bg-background/90 px-4 backdrop-blur">
        <Link href="/driver/dashboard" aria-label="My deliveries">
          <Brand />
        </Link>
        <form action={driverLogout}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4 pb-10">{children}</main>
    </div>
  );
}
