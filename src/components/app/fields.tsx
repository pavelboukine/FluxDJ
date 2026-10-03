import type { ComponentProps, ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, className, ...props }: ComponentProps<typeof Input> & { label: string; hint?: ReactNode; name: string }) {
  const id = props.id ?? props.name;
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <Input id={id} {...props} />
    </Field>
  );
}

export function TextAreaField({ label, hint, className, ...props }: ComponentProps<typeof Textarea> & { label: string; hint?: ReactNode; name: string }) {
  const id = props.id ?? props.name;
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <Textarea id={id} {...props} />
    </Field>
  );
}

export const selectClass =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30";

export function SelectField({
  label,
  hint,
  options,
  className,
  placeholder,
  ...props
}: ComponentProps<"select"> & { label: string; hint?: ReactNode; name: string; options: { value: string; label: string }[]; placeholder?: string }) {
  const id = props.id ?? props.name;
  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <select id={id} className={selectClass} {...props}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CheckboxField({ label, name, defaultChecked, hint }: { label: string; name: string; defaultChecked?: boolean; hint?: ReactNode }) {
  return (
    <div className="grid gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-4 accent-primary" />
        {label}
      </label>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
