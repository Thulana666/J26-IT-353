import Link from "next/link";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

// Temporary landing page with links to sign in and sign up.
export default function Home() {
  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Brand />
          <nav className="flex items-center gap-2">
            <Button variant="ghost" nativeButton={false} render={<Link href="/login" />}>
              Sign in
            </Button>
            <Button nativeButton={false} render={<Link href="/signup" />}>
              Sign up
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center sm:px-6">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Welcome to PharmaTwin
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Sign in to your account to access the dashboard, or create a new
          account to get started.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button size="lg" className="px-5" nativeButton={false} render={<Link href="/signup" />}>
            Create an account
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="px-5"
            nativeButton={false}
            render={<Link href="/login" />}
          >
            Sign in
          </Button>
        </div>
      </main>

      <footer className="py-6 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} PharmaTwin
      </footer>
    </div>
  );
}
