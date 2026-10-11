import type { ReactNode } from "react";
import { Users } from "lucide-react";
import { PublicShell } from "@/components/app/public-shell";

/** The frame of the staff invitation pages, in the sign-in pages' style. */
export function InviteCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <PublicShell>
      <div className="flex flex-1 items-start justify-center pt-6 sm:items-center sm:pt-0">
        <section aria-labelledby="invite-heading" className="grid w-full max-w-md gap-6 rounded-2xl border bg-card/95 p-6 shadow-sm backdrop-blur sm:p-8">
          <div className="grid gap-3">
            <span aria-hidden className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Users className="size-5" />
            </span>
            <h1 id="invite-heading" className="text-2xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
            {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <div className="grid gap-4 text-sm">{children}</div>
        </section>
      </div>
    </PublicShell>
  );
}
