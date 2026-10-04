import Link from "next/link";
import { Brand } from "@/components/brand";
import { UserMenu } from "@/components/dashboard/user-menu";

export function SiteHeader({ profile, email }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/dashboard">
          <Brand />
        </Link>
        <UserMenu
          name={profile?.full_name}
          email={profile?.email ?? email}
          role={profile?.role ?? "user"}
        />
      </div>
    </header>
  );
}
