import { AuthShell } from "@/components/auth/auth-shell";
import { DriverLoginForm } from "@/components/driver/driver-login-form";

export const metadata = { title: "Driver sign in | PharmaTwin" };

export default function DriverLoginPage() {
  return (
    <AuthShell>
      <DriverLoginForm />
    </AuthShell>
  );
}
