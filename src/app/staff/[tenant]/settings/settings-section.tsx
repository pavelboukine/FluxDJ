import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One titled group on a settings page, set off by a hairline and spacing rather than a card. */
export function SettingsSection({ title, description, children, className, ...props }: Omit<ComponentProps<"section">, "title"> & { title: string; description?: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("grid max-w-2xl min-w-0 scroll-mt-20 gap-4 border-t pt-8", className)} {...props}>
      <div className="grid gap-1">
        <h2 id={headingId} className="text-base font-semibold">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Values that can't be edited here, as plain text on hairlines, so they never look like inputs. */
export function ReadOnlyRows({ children, ...props }: ComponentProps<"dl">) {
  return <dl className="divide-y border-y text-sm" {...props}>{children}</dl>;
}

export function ReadOnlyRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 gap-0.5">
        <span className="font-medium whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}
