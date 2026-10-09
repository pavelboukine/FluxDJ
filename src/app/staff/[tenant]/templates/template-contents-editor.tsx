"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChoicePicker } from "@/components/app/choice-picker";
import { selectClass } from "@/components/app/fields";
import { GearThumb } from "@/components/app/gear-thumb";
import { answerTypeLabel } from "@/lib/catalog/rules";
import type { GearChoice } from "@/lib/catalog/gear-choices.server";
import { formatCents } from "@/lib/money";
import type { PackageChoice, QuestionChoice } from "./choices.server";

export type TemplateContents = {
  packageIds: [string, string, string];
  recommended: string;
  questionIds: string[];
  addons: { id: string; rec: number; max: number }[];
};

type Addon = { id: string; rec: string; max: string };

/**
 * A template's contents inside a form, as the fields saveTemplateComposition
 * and createTemplate read: package_1..3 (presentation order),
 * default_package_id (one of them, or none), question (in order), and
 * addon with rec:<id> / max:<id>. Archived packages, questions and gear the
 * template already uses stay listed and flagged, never dropped silently;
 * only active ones can be added.
 */
export function TemplateContentsEditor({
  packages,
  questions,
  gear,
  initial,
  currency,
}: {
  packages: PackageChoice[];
  questions: QuestionChoice[];
  gear: GearChoice[];
  initial: TemplateContents;
  currency: string;
}) {
  const [slots, setSlots] = useState<[string, string, string]>(initial.packageIds);
  const [recommended, setRecommended] = useState(initial.recommended);
  const [questionIds, setQuestionIds] = useState(initial.questionIds);
  const [addons, setAddons] = useState<Addon[]>(() => initial.addons.map((a) => ({ id: a.id, rec: String(a.rec), max: String(a.max) })));
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const pkgById = useMemo(() => new Map(packages.map((p) => [p.id, p])), [packages]);
  const qById = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);
  const gearById = useMemo(() => new Map(gear.map((g) => [g.id, g])), [gear]);
  const chosen = slots.filter(Boolean);

  // Structural changes (add, remove, reorder) change fields without an input
  // event; announce one so the form's unsaved-changes state follows.
  const shape = JSON.stringify([slots, questionIds, addons.map((a) => a.id), recommended]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [shape]);

  function setSlot(index: number, id: string) {
    const next = [...slots] as [string, string, string];
    next[index] = id;
    setSlots(next);
    // The recommended package must stay one of the three.
    if (recommended && !next.includes(recommended)) setRecommended("");
  }
  function swap(a: number, b: number) {
    setSlots((s) => {
      const next = [...s] as [string, string, string];
      [next[a], next[b]] = [next[b], next[a]];
      return next;
    });
  }
  function move<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  }
  const focusLater = (id: string) => window.requestAnimationFrame(() => document.getElementById(id)?.focus());

  return (
    <div ref={box} className="grid min-w-0 gap-8" data-testid="template-contents-editor">
      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 grid gap-0.5">
          <span className="text-sm font-semibold">Packages</span>
          <span className="text-xs font-normal text-muted-foreground">Clients see three packages side by side, in this order. Each can appear once.</span>
        </legend>
        <ol className="grid gap-3 lg:grid-cols-3">
          {slots.map((id, i) => {
            const p = id ? pkgById.get(id) : undefined;
            const options = packages.filter((c) => (c.active && (c.id === id || !slots.includes(c.id))) || c.id === id);
            return (
              <li key={i} className="grid min-w-0 content-start gap-2 rounded-lg border p-3" data-testid="package-slot">
                <label htmlFor={`package_${i + 1}`} className="text-sm font-medium">
                  Package {i + 1}
                </label>
                <select id={`package_${i + 1}`} name={`package_${i + 1}`} value={id} onChange={(e) => setSlot(i, e.target.value)} className={selectClass}>
                  <option value="">— Choose a package —</option>
                  {options.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {formatCents(c.basePriceCents, currency)}
                      {c.active ? "" : " (archived)"}
                    </option>
                  ))}
                </select>
                {p ? (
                  <div className="grid gap-1 text-xs" data-testid="slot-summary">
                    <span>
                      <span className="text-sm font-semibold">{formatCents(p.basePriceCents, currency)}</span> <span className="text-muted-foreground">base price, before tax</span>
                    </span>
                    <span className="text-muted-foreground">{p.gearSummary}</span>
                    {!p.active ? <span className="text-amber-800 dark:text-amber-300">Archived package: proposals from this template can&apos;t be sent until you replace it or restore it.</span> : null}
                    {p.archivedGear > 0 ? <span className="text-amber-800 dark:text-amber-300">Includes archived gear.</span> : null}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Empty. A proposal needs three packages before it can be sent.</p>
                )}
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move package ${i + 1} earlier`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
                    <ArrowUp aria-hidden className="lg:hidden" />
                    <ArrowLeft aria-hidden className="hidden lg:block" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Move package ${i + 1} later`} disabled={i === 2} onClick={() => swap(i, i + 1)}>
                    <ArrowDown aria-hidden className="lg:hidden" />
                    <ArrowRight aria-hidden className="hidden lg:block" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <fieldset className="grid min-w-0 gap-1.5">
          <legend className="mb-1 text-sm font-medium">Recommended package</legend>
          <p className="text-xs text-muted-foreground">Shown to clients as “Recommended” and preselected. Clients can still choose another.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {chosen.map((id) => (
              <label key={id} className="flex items-center gap-2">
                <input type="radio" name="default_package_id" value={id} checked={recommended === id} onChange={() => setRecommended(id)} className="size-4 accent-primary" />
                {pkgById.get(id)?.name ?? "Unavailable package"}
              </label>
            ))}
            <label className="flex items-center gap-2 text-muted-foreground">
              <input type="radio" name="default_package_id" value="" checked={recommended === ""} onChange={() => setRecommended("")} className="size-4 accent-primary" />
              None yet
            </label>
          </div>
        </fieldset>
      </fieldset>

      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 grid gap-0.5">
          <span className="text-sm font-semibold">Questions</span>
          <span className="text-xs font-normal text-muted-foreground">Asked on the proposal, in this order. Their rules decide which gear is required.</span>
        </legend>
        {questionIds.length > 0 ? (
          <ol aria-label="Template questions" className="divide-y rounded-lg border">
            {questionIds.map((id, i) => {
              const q = qById.get(id);
              const label = q?.prompt ?? "Unavailable question";
              return (
                <li key={id} data-testid="question-row" className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <input type="hidden" name="question" value={id} />
                  <span className="grid min-w-0">
                    <span className="text-sm font-medium [overflow-wrap:anywhere]">
                      {i + 1}. {label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {q ? `${answerTypeLabel(q.answerType)} · ${q.required ? "Required" : "Optional"} · ${q.activeRules === 0 ? "no rules" : `${q.activeRules} rule${q.activeRules === 1 ? "" : "s"}`}` : null}
                    </span>
                    {q && !q.active ? (
                      <span className="text-xs text-amber-800 dark:text-amber-300">Archived question: proposals from this template can&apos;t be sent until you remove it or restore it.</span>
                    ) : null}
                  </span>
                  <span className="flex gap-1">
                    <Button id={`q-up-${id}`} type="button" variant="ghost" size="icon" aria-label={`Move “${label}” earlier`} disabled={i === 0} onClick={() => { setQuestionIds((l) => move(l, i, i - 1)); focusLater(`q-up-${id}`); }}>
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button id={`q-down-${id}`} type="button" variant="ghost" size="icon" aria-label={`Move “${label}” later`} disabled={i === questionIds.length - 1} onClick={() => { setQuestionIds((l) => move(l, i, i + 1)); focusLater(`q-down-${id}`); }}>
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove “${label}”`} onClick={() => setQuestionIds((l) => l.filter((x) => x !== id))}>
                      <X aria-hidden />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No questions. Proposals from this template won&apos;t ask any, so no rules apply.</p>
        )}
        <ChoicePicker
          noun="a question"
          available={questions.filter((q) => q.active && !questionIds.includes(q.id)).map((q) => ({ id: q.id, label: q.prompt, detail: `${answerTypeLabel(q.answerType)} · ${q.required ? "Required" : "Optional"}` }))}
          total={questions.filter((q) => q.active).length}
          onAdd={(id) => setQuestionIds((l) => [...l, id])}
          emptyText="There are no active questions yet. Add them under Questions & rules."
          allAddedText="All active questions are asked."
        />
      </fieldset>

      <fieldset className="grid min-w-0 gap-3">
        <legend className="mb-3 grid gap-0.5">
          <span className="text-sm font-semibold">Optional extras</span>
          <span className="text-xs font-normal text-muted-foreground">
            Gear clients may add on top of their package, charged at each item&apos;s unit price. “Preselected” starts the client at that quantity.
          </span>
        </legend>
        {addons.length > 0 ? (
          <ul aria-label="Optional extras" className="divide-y rounded-lg border">
            {addons.map((a) => {
              const g = gearById.get(a.id);
              const name = g?.name ?? "Unavailable gear item";
              const rec = Number(a.rec);
              const max = Number(a.max);
              const invalid = Number.isInteger(rec) && Number.isInteger(max) && rec > max;
              return (
                <li key={a.id} data-testid="addon-row" className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <input type="hidden" name="addon" value={a.id} />
                  <span className="flex min-w-0 items-center gap-3">
                    <GearThumb url={g?.thumbUrl ?? null} />
                    <span className="grid min-w-0">
                      <span className="truncate text-sm font-medium">{name}</span>
                      {g && !g.active ? <span className="text-xs text-amber-800 dark:text-amber-300">Archived gear: proposals from this template can&apos;t be sent until you remove it or restore it.</span> : null}
                      {invalid ? <span className="text-xs text-destructive" role="alert">Preselected can&apos;t be more than the maximum.</span> : null}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Preselected
                      <Input name={`rec:${a.id}`} type="number" inputMode="numeric" min={0} max={100} required value={a.rec} aria-invalid={invalid || undefined} onChange={(e) => setAddons((l) => l.map((x) => (x.id === a.id ? { ...x, rec: e.target.value } : x)))} aria-label={`Preselected quantity of ${name}`} className="w-16" />
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      Up to
                      <Input name={`max:${a.id}`} type="number" inputMode="numeric" min={1} max={100} required value={a.max} onChange={(e) => setAddons((l) => l.map((x) => (x.id === a.id ? { ...x, max: e.target.value } : x)))} aria-label={`Maximum quantity of ${name}`} className="w-16" />
                    </label>
                    <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={() => setAddons((l) => l.filter((x) => x.id !== a.id))}>
                      <X aria-hidden />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No optional extras.</p>
        )}
        <ChoicePicker
          noun="gear"
          available={gear.filter((g) => g.active && !addons.some((a) => a.id === g.id)).map((g) => ({ id: g.id, label: g.name, thumbUrl: g.thumbUrl }))}
          total={gear.filter((g) => g.active).length}
          onAdd={(id) => setAddons((l) => [...l, { id, rec: "0", max: "1" }])}
          thumbs
          emptyText="There is no active gear yet."
          allAddedText="All active gear is offered."
        />
      </fieldset>
      <p className="text-xs text-muted-foreground">Each package, question and extra appears once. Quantities are whole numbers up to 100.</p>
    </div>
  );
}

