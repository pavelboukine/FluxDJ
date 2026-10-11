"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/app/action-form";
import type { SignInRole } from "@/lib/auth/redirects";
import { idleState } from "@/lib/forms";
import { sendMagicLink, verifySignInCode } from "./actions";

/**
 * Email a sign-in link; the same email carries a code. The link opens in the
 * phone's browser (with its explicit "Sign in" step); the code can be typed
 * here, which is how the app added to an iPhone's Home Screen signs in.
 * The role and the page to return to travel with both forms; the server
 * validates them again.
 */
export function LoginForm({ role, next }: { role: SignInRole | null; next: string | null }) {
  const [email, setEmail] = useState("");
  const [state, action, pending] = useActionState(sendMagicLink, idleState);
  const [codeState, codeAction, codePending] = useActionState(verifySignInCode, idleState);
  const sent = state.status === "success";
  return (
    <div className="grid gap-4">
      <form action={action} className="grid gap-4">
        {role ? <input type="hidden" name="role" value={role} /> : null}
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required placeholder={role === "client" ? "you@example.com" : "you@yourbusiness.com"} value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 text-base sm:text-sm" />
        </div>
        <Button type="submit" size="lg" disabled={pending} variant={sent ? "outline" : "default"}>
          {pending ? "Sending…" : "Email me a sign-in link"}
        </Button>
        <FormMessage state={state} />
      </form>
      {sent ? (
        <form action={codeAction} className="grid gap-3 rounded-xl border bg-muted/30 p-4" data-testid="code-form">
          {role ? <input type="hidden" name="role" value={role} /> : null}
          {next ? <input type="hidden" name="next" value={next} /> : null}
          {email ? (
            <input type="hidden" name="email" value={email} />
          ) : (
            // Without JavaScript the typed address isn't kept across the submit: ask again.
            <div className="grid gap-1.5">
              <Label htmlFor="code-address">Address the code was sent to</Label>
              <Input id="code-address" name="email" type="email" autoComplete="email" required />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="code">Code from the email</Label>
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,12}" required className="h-11 max-w-[12rem] text-base tracking-widest" />
            <p className="text-xs text-muted-foreground">
              Tap the link in the email, or type its code here. Using Flux DJ from your home screen? Use the code: links open in your browser
              instead of the app.
            </p>
          </div>
          <Button type="submit" disabled={codePending} className="justify-self-start">
            {codePending ? "Checking…" : "Sign in with code"}
          </Button>
          <FormMessage state={codeState} />
        </form>
      ) : null}
    </div>
  );
}
