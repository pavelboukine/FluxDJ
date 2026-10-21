"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { LabelText } from "./label-text";

/**
 * Planning's one choice pattern (radios and checkboxes): full-width rounded rows on spacing (no
 * lines or box around them), the chosen row on the business's Brand Tint. The whole
 * row is the hit target (44px), the native control keeps keyboard and screen-reader behaviour,
 * and "Not sure yet — discuss…" options end the list, in the same full-contrast text as the others
 * (only options that can't be chosen are greyed). Read-only planning shows only what was chosen
 * (see globals.css).
 */

/** Values shown as the separate, quieter "not sure yet" option. */
export const SECONDARY_CHOICES = ["discuss"];

export function ChoiceOption({ type = "radio", name, checked, disabled, onChange, label, hint, note, secondary, testId, ariaLabel }: {
  type?: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** A line under the label (what the option means). */
  hint?: ReactNode;
  /** Why it can't be chosen right now, or another short note. */
  note?: ReactNode;
  /** The "not sure yet" option, at the end of the list (marked for styles and tests). */
  secondary?: boolean;
  testId?: string;
  ariaLabel?: string;
}) {
  return (
    <label
      data-choice-option
      data-secondary={secondary ? "" : undefined}
      data-testid={testId}
      className={cn(
        // Every option is the same rounded surface: quiet grey on hover, the business's colour when
        // chosen (a little stronger than Brand Tint, so it still shows on an open question's wash).
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2.5 transition-colors duration-150 motion-reduce:transition-none",
        "hover:bg-plan-track/60",
        "has-[:checked]:bg-[color-mix(in_oklab,var(--brand-ink,var(--foreground))_10%,white)] has-[:checked]:hover:bg-[color-mix(in_oklab,var(--brand-ink,var(--foreground))_14%,white)]",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-ink",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:bg-transparent",
      )}
    >
      <input
        type={type}
        name={name}
        className="mt-0.5 size-[1.125rem] shrink-0 disabled:opacity-60"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className={cn("text-sm leading-snug [overflow-wrap:anywhere]", disabled && !checked ? "text-plan-ink-2" : "text-foreground")}>{label}</span>
        {hint ? <span className="text-xs text-plan-ink-2">{hint}</span> : null}
        {note ? <span className="text-xs text-plan-ink-2">{note}</span> : null}
      </span>
    </label>
  );
}

/**
 * A choice group: its question as the legend, the main options in one hairline-separated list,
 * then any secondary option apart, then whatever follows (a field the choice opens, an error).
 */
export function ChoiceFieldset({ legend, legendHidden, disabled, children, secondary, after, className, testId, columns }: {
  legend: string;
  legendHidden?: boolean;
  disabled?: boolean;
  /** The main options (ChoiceOption rows). */
  children: ReactNode;
  /** Options shown apart, below (the "not sure yet" choice). */
  secondary?: ReactNode;
  /** Fields or messages after the options. */
  after?: ReactNode;
  className?: string;
  testId?: string;
  /** Two columns from small screens up (short checkbox lists such as music styles). */
  columns?: 2;
}) {
  return (
    <fieldset disabled={disabled} data-choice-group className={cn("grid min-w-0 content-start gap-1.5", className)} data-testid={testId}>
      <legend className={legendHidden ? "sr-only" : "mb-1.5 flex flex-wrap items-baseline gap-2 text-sm leading-snug font-medium"}>
        <LabelText text={legend} />
      </legend>
      {/* Options sit on spacing, not lines: each is its own rounded surface. The -mx-2 lines the controls
          up with the question while their hover and selection keep a little room around the text. */}
      <div className={cn("-mx-2 grid gap-0.5", columns === 2 && "sm:grid-cols-2 sm:gap-x-2")}>
        {children}
        {/* The quieter "not sure yet" option ends the same list, with the same spacing as the others. */}
        {secondary ? <div className="col-span-full grid gap-0.5">{secondary}</div> : null}
      </div>
      {after}
    </fieldset>
  );
}

/** One standalone checkbox row (a yes/no flag such as "No separate arrival arrangements"). */
export function ChoiceSingle(props: Parameters<typeof ChoiceOption>[0]) {
  return (
    <div data-choice-group className="col-span-full -mx-2 grid">
      <ChoiceOption type="checkbox" {...props} />
    </div>
  );
}

/** A labelled radio group from a list of options (the common case). */
export function Choices<C extends string>({ name, legend, value, options, onChange, error, disabled, after }: {
  name: string;
  legend: string;
  value: C | "";
  options: { value: C | ""; label: string; hint?: string; blocked?: string | null }[];
  onChange: (value: C | "") => void;
  error?: string | null;
  disabled?: boolean;
  after?: ReactNode;
}) {
  const row = (o: (typeof options)[number], secondary = false) => (
    <ChoiceOption
      key={o.value || "list"}
      name={name}
      checked={value === o.value}
      disabled={Boolean(o.blocked)}
      onChange={() => onChange(o.value)}
      label={o.label}
      hint={o.hint}
      note={o.blocked}
      secondary={secondary}
    />
  );
  const main = options.filter((o) => !SECONDARY_CHOICES.includes(o.value));
  const apart = options.filter((o) => SECONDARY_CHOICES.includes(o.value));
  return (
    <ChoiceFieldset
      legend={legend}
      disabled={disabled}
      secondary={apart.length > 0 ? apart.map((o) => row(o, true)) : undefined}
      after={
        <>
          {after}
          {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
        </>
      }
    >
      {main.map((o) => row(o))}
    </ChoiceFieldset>
  );
}
