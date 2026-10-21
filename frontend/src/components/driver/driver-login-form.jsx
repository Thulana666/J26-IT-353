"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { driverLogin } from "@/app/driver/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Driver sign-in, sized for phones (large fields and button). Same accounts
// as the rest of PharmaTwin.
export function DriverLoginForm() {
  const [state, formAction, isPending] = useActionState(driverLogin, null);
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Driver sign in</CardTitle>
        <CardDescription>See your deliveries, report issues and confirm delivery.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4">
          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" className="h-12 text-base" key={state?.email} defaultValue={state?.email} required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" className="h-12 text-base" required />
          </div>
          <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" />}
            {isPending ? "Signing in..." : "Sign in"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            No account yet? Sign up on the main PharmaTwin page, then ask the warehouse to link it to your driver profile.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
