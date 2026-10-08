import { Brand } from "@/components/brand";

// Centered layout shared by the login and signup pages.
export function AuthShell({ children }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Brand className="self-center text-lg" />
        {children}
      </div>
    </main>
  );
}
