"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { signup } from "@/app/signup/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignupForm() {
  const [state, formAction, isPending] = useActionState(signup, null);

  // Remount inputs when the action returns so entered values are kept.
  const key = JSON.stringify(state?.values ?? {});

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Create an account</CardTitle>
        <CardDescription>Enter your details to get started.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="grid gap-4">
          {state?.error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor="full_name">Full name</Label>
            <Input
              key={`name-${key}`}
              id="full_name"
              name="full_name"
              autoComplete="name"
              placeholder="Jane Perera"
              defaultValue={state?.values?.fullName}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              key={`email-${key}`}
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              defaultValue={state?.values?.email}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm_password">Confirm password</Label>
            <Input
              id="confirm_password"
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={isPending}>
            {isPending && <Loader2 className="animate-spin" />}
            {isPending ? "Creating account..." : "Create account"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
