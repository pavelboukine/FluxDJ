"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxField, TextField } from "@/components/app/fields";
import { ANSWER_TYPES, type AnswerType, type QuestionOption } from "@/lib/catalog/rules";

const TYPE_HELP: Record<AnswerType, string> = {
  boolean: "The client answers Yes or No. Rules can react to either.",
  single_choice: "The client picks one of your choices. Rules can react to one or several of them.",
  multi_choice: "The client picks any number of your choices. Rules react when a given choice is picked.",
  short_text: "The client writes a short answer for you to read. It can't trigger rules.",
};

type Row = { rowKey: string; value: string; label: string };

/**
 * A question's choices inside a form, as option_value / option_label pairs
 * in order. An existing choice keeps its value when its label changes (rules
 * and earlier answers match on the value); a new one gets a value made from
 * its label when saved. Choices that a rule uses can't be removed here.
 */
function ChoicesEditor({ initial, inUse }: { initial: QuestionOption[]; inUse: Record<string, number> }) {
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length > 0 ? initial.map((o) => ({ rowKey: o.value, value: o.value, label: o.label })) : [{ rowKey: "new-0", value: "", label: "" }],
  );
  const counter = useRef(1);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const shape = rows.map((r) => r.rowKey).join(",");
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [shape]);

  function add() {
    const rowKey = `new-${counter.current++}`;
    setRows((r) => [...r, { rowKey, value: "", label: "" }]);
    window.requestAnimationFrame(() => document.getElementById(`choice-${rowKey}`)?.focus());
  }
  function move(i: number, to: number) {
    setRows((r) => {
      const next = [...r];
      const [row] = next.splice(i, 1);
      next.splice(to, 0, row);
      return next;
    });
  }

  return (
    <div ref={box} className="grid min-w-0 gap-2 sm:col-span-2" data-testid="choices-editor">
      <ol aria-label="Choices" className="grid gap-2">
        {rows.map((row, i) => {
          const uses = row.value ? (inUse[row.value] ?? 0) : 0;
          const name = row.label.trim() || `choice ${i + 1}`;
          return (
            <li key={row.rowKey} className="grid gap-1" data-testid="choice-row">
              <div className="flex items-center gap-1">
                <input type="hidden" name="option_value" value={row.value} />
                <Input
                  id={`choice-${row.rowKey}`}
                  name="option_label"
                  value={row.label}
                  maxLength={200}
                  required
                  aria-label={`Choice ${i + 1}`}
                  placeholder={i === 0 ? "A separate space" : "Another choice"}
                  onChange={(e) => setRows((r) => r.map((x) => (x.rowKey === row.rowKey ? { ...x, label: e.target.value } : x)))}
                  className="min-w-0 flex-1"
                />
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} down`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${name}`}
                  disabled={uses > 0 || rows.length === 1}
                  onClick={() => setRows((r) => r.filter((x) => x.rowKey !== row.rowKey))}
                >
                  <X aria-hidden />
                </Button>
              </div>
              {uses > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Used by {uses === 1 ? "a rule" : `${uses} rules`} (active or archived), so it can&apos;t be removed. Renaming it is fine: rules keep matching it.
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={rows.length >= 50}>
          <Plus aria-hidden />
          Add a choice
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Clients see the choices in this order. Up to 50.</p>
    </div>
  );
}

/**
 * The question form: the question, its answer type (fixed once saved) and
 * choices, whether an answer is required, then display order and key.
 */
export function QuestionFields({
  question,
  inUse = {},
}: {
  question?: { prompt: string; answer_type: string; options: QuestionOption[]; required: boolean; sort_order: number; key: string };
  inUse?: Record<string, number>;
}) {
  const [type, setType] = useState<AnswerType>((question?.answer_type as AnswerType) ?? "single_choice");
  const choice = type === "single_choice" || type === "multi_choice";
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">All fields are required unless marked optional.</p>
      <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold">The question clients answer</legend>
        <TextField className="sm:col-span-2" label="Question" name="prompt" required maxLength={500} defaultValue={question?.prompt} placeholder="Where will the ceremony take place?" />
        {question ? (
          <div className="grid gap-1 sm:col-span-2">
            <p className="text-sm font-medium">Answer type</p>
            <p className="text-sm">
              {ANSWER_TYPES.find(([t]) => t === type)?.[1]} <span className="text-xs text-muted-foreground">(can&apos;t change once saved: rules and sent proposals rely on it)</span>
            </p>
          </div>
        ) : (
          <fieldset className="grid min-w-0 gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Answer type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ANSWER_TYPES.map(([value, label]) => (
                <label key={value} className="flex items-start gap-2 rounded-lg border p-3 text-sm has-[:checked]:border-primary">
                  <input type="radio" name="answer_type" value={value} checked={type === value} onChange={() => setType(value)} className="mt-0.5 size-4 accent-primary" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{TYPE_HELP[value]}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">The answer type can&apos;t change once the question is saved.</p>
          </fieldset>
        )}
        {choice ? (
          <fieldset className="grid min-w-0 gap-2 sm:col-span-2">
            <legend className="mb-1 text-sm font-medium">Choices</legend>
            <ChoicesEditor initial={question?.options ?? []} inUse={inUse} />
          </fieldset>
        ) : null}
        <div className="sm:col-span-2">
          <CheckboxField
            label="An answer is required"
            name="required"
            defaultChecked={question?.required ?? true}
            hint="Clients can't submit the proposal without answering. Optional questions can be left blank, and then their rules don't apply."
          />
        </div>
      </fieldset>
      <fieldset className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold">Other settings</legend>
        <TextField
          label="Display order"
          name="sort_order"
          type="number"
          inputMode="numeric"
          min={0}
          max={10000}
          required
          defaultValue={question?.sort_order ?? 0}
          hint="Lower numbers come first in the questions list and pickers. Each template sets its own order."
        />
        {question ? (
          <TextField label="Key" name="key_display" defaultValue={question.key} disabled hint="Keys never change." />
        ) : (
          <TextField label="Key (optional)" name="key" maxLength={64} pattern="[a-z][a-z0-9_]*" placeholder="ceremony_location" hint="A stable identifier in proposals. Made from the question if left empty." />
        )}
      </fieldset>
    </div>
  );
}
