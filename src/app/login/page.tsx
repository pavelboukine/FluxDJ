import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Staff sign in · Flux DJ" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Staff sign in</CardTitle>
          <CardDescription>No password. We email you a one-time sign-in link.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              That sign-in link is invalid or has expired. Request a new one.
            </p>
          ) : null}
          <LoginForm />
          {process.env.NODE_ENV === "development" ? (
            <p className="text-xs text-muted-foreground">
              Local development: emails are captured at{" "}
              <a className="underline" href="http://127.0.0.1:54324" target="_blank" rel="noreferrer">
                http://127.0.0.1:54324
              </a>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
