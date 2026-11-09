"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/app/fields";
import { RowAction } from "@/components/planning/row-action";
import { CreateOwnItem, CustomQuestionsAuthor } from "@/components/planning/custom-authoring";
import type { CustomQuestion } from "@/lib/planning/custom-questions";
import type { ActionState } from "@/lib/forms";
import type { QuestionSummary } from "@/lib/planning/question-summaries";
import type { ItemRole, LibraryEntry } from "@/lib/planning/template-structure";
import { cn } from "@/lib/utils";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * summary: what the client is asked in this item (built-in, read-only), or null when it has no form of its own.
 * custom: the DJ's own item; `questions` are its own (a section or moment; a stage has none).
 */
export type EditorItem = {
  id: string; key: string; label: string; removable: boolean; role: ItemRole; summary: QuestionSummary | null;
  custom: boolean; questions?: CustomQuestion[];
};
export type EditorStage = EditorItem & { moments: EditorItem[]; addable: LibraryEntry[] };

type Props = {
  general: EditorItem[];
  stages: EditorStage[];
  addableGeneral: LibraryEntry[];
  addableStages: LibraryEntry[];
  version: number;
  itemAction: Action;
  addAction: Action;
  /** Creates the DJ's own section, stage or moment. */
  customAction: Action;
  /** Saves a custom item's questions. */
  questionsAction: Action;
  readOnly: boolean;
};

const ROLE_BADGE: Record<ItemRole["kind"], string> = {
  section: "Client section",
  group: "Client section",
  fill: "Client fills in",
  details: "In stage details",
  covered: "Answered elsewhere",
  not_shown: "Not shown to clients",
};

/**
 * The template's structure as an outline: general sections, then the stages
 * in event order, each with its moments (collapsed until opened). Every row
 * says what it becomes for the client. Each change is its own small
 * version-checked request (rename, move, remove, add), so a stale tab gets a
 * conflict instead of overwriting. Removed items are listed under "Not in
 * this template" and can be added back.
 */
export function TemplateStructureEditor({ general, stages, addableGeneral, addableStages, version, itemAction, addAction, customAction, questionsAction, readOnly }: Props) {
  const common = { version, itemAction, questionsAction, readOnly };
  return (
    <div className="grid gap-8">
      <section aria-labelledby="general-heading" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="general-heading" className="text-base font-semibold">General sections</h2>
          <p className="text-sm text-muted-foreground">
            Clients see these first, under &ldquo;Event details&rdquo;, in this order. General sections keep their order; only stages and moments move.
          </p>
        </div>
        <ul className="grid divide-y rounded-xl border bg-card" aria-label="General sections">
          {general.map((g) => (
            <li key={g.id} className="p-3 sm:px-4" data-testid={`row-${g.key}`}>
              <ItemRow item={g} {...common} />
            </li>
          ))}
        </ul>
        {!readOnly && addableGeneral.length > 0 ? (
          <AddPicker label="Add a general section" options={addableGeneral.map((l) => ({ value: l.key, label: l.default_label }))} version={version} addAction={addAction} />
        ) : null}
        {!readOnly ? <CreateOwnItem kind="general" version={version} action={customAction} /> : null}
      </section>

      <section aria-labelledby="stages-heading" className="grid gap-3">
        <div className="grid gap-1">
          <h2 id="stages-heading" className="text-base font-semibold">Event stages, in order</h2>
          <p className="text-sm text-muted-foreground">
            Clients see these under &ldquo;Your event, in order&rdquo;. Each stage holds its moments; open a stage to arrange them.
          </p>
        </div>
        {stages.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No stages yet. Add the first one below.</p>
        ) : (
          <ol className="grid gap-3" aria-label="Event stages, in order">
            {stages.map((s, i) => (
              <li key={s.id} className="min-w-0">
                <StageBlock stage={s} index={i} count={stages.length} addAction={addAction} customAction={customAction} {...common} />
              </li>
            ))}
          </ol>
        )}
        {!readOnly && addableStages.length > 0 ? (
          <AddPicker label="Add a stage" hint="New stages go last; move them into place." options={addableStages.map((l) => ({ value: l.key, label: l.default_label }))} version={version} addAction={addAction} />
        ) : null}
        {!readOnly ? <CreateOwnItem kind="stage" version={version} action={customAction} /> : null}
      </section>
    </div>
  );
}

type Common = { version: number; itemAction: Action; questionsAction: Action; readOnly: boolean };

function StageBlock({ stage, index, count, addAction, customAction, ...common }: Common & { stage: EditorStage; index: number; count: number; addAction: Action; customAction: Action }) {
  // A new custom stage opens on its (empty) moments, ready for the first one.
  const [open, setOpen] = useState(stage.custom && stage.moments.length === 0);
  const panel = `moments-${stage.key}`;
  return (
    <div className="grid min-w-0 rounded-xl border bg-card" data-testid={`stage-${stage.key}`}>
      <div className="p-3 sm:px-4" data-testid={`row-${stage.key}`}>
        <ItemRow
          item={stage}
          number={index + 1}
          move={{ first: index === 0, last: index === count - 1 }}
          removeNote={stage.moments.length > 0 ? ` and its ${stage.moments.length} moment${stage.moments.length === 1 ? "" : "s"}` : ""}
          {...common}
        />
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 min-w-0 items-center gap-2 border-t px-3 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-4"
      >
        <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        <span>
          {stage.moments.length === 0 ? "No moments" : `${stage.moments.length} moment${stage.moments.length === 1 ? "" : "s"}`}
          <span className="sr-only"> in {stage.label}</span>
        </span>
        {!open && stage.moments.length > 0 ? (
          <span aria-hidden className="min-w-0 truncate font-normal text-muted-foreground">{stage.moments.map((m) => m.label).join(" · ")}</span>
        ) : null}
      </button>
      <div id={panel} hidden={!open} className="grid gap-3 border-t bg-muted/20 p-3 sm:px-4">
        {stage.moments.length > 0 ? (
          <ol className="grid divide-y rounded-lg border bg-card" aria-label={`Moments in ${stage.label}`}>
            {stage.moments.map((m, j) => (
              <li key={m.id} className="p-3" data-testid={`row-${m.key}`}>
                <ItemRow item={m} move={{ first: j === 0, last: j === stage.moments.length - 1 }} {...common} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">This stage has no moments yet.</p>
        )}
        {!common.readOnly && stage.addable.length > 0 ? (
          <div className="grid gap-1.5" role="group" aria-label={`Moments not in ${stage.label}`}>
            <p className="text-xs font-medium text-muted-foreground">Not in this template (add to {stage.label})</p>
            <div className="flex flex-wrap gap-2">
              {stage.addable.map((l) => (
                <RowAction
                  key={l.key}
                  action={addAction}
                  version={common.version}
                  fields={{ item: `${l.key}|${stage.key}` }}
                  submitLabel={<><Plus aria-hidden />{l.default_label}</>}
                  ariaLabel={`Add ${l.default_label} to ${stage.label}`}
                  pendingLabel="Adding…"
                  variant="outline"
                />
              ))}
            </div>
          </div>
        ) : null}
        {!common.readOnly ? <CreateOwnItem kind="moment" parentKey={stage.key} parentLabel={stage.label} version={common.version} action={customAction} /> : null}
      </div>
    </div>
  );
}

function ItemRow({ item, number, move, removeNote = "", version, itemAction, questionsAction, readOnly }: Common & {
  item: EditorItem;
  number?: number;
  move?: { first: boolean; last: boolean };
  removeNote?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="grid min-w-0 flex-1 gap-1">
          {renaming ? (
            <RowAction
              action={itemAction}
              version={version}
              fields={{ op: "rename", item_id: item.id }}
              submitLabel="Save"
              ariaLabel={`Save the name of ${item.label}`}
              onSuccess={() => setRenaming(false)}
              className="w-full"
            >
              <Input
                name="label"
                defaultValue={item.label}
                maxLength={120}
                required
                autoFocus
                aria-label={`Label for ${item.label}`}
                className="h-8 min-w-0 flex-1 sm:max-w-sm"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            </RowAction>
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium [overflow-wrap:anywhere]">
                {number !== undefined ? <span className="text-muted-foreground">{number}. </span> : null}
                {item.label}
              </span>
              <Badge variant={item.role.kind === "not_shown" ? "secondary" : "outline"}>{ROLE_BADGE[item.role.kind]}</Badge>
              {item.custom ? <Badge variant="secondary">Your own</Badge> : null}
            </span>
          )}
          <p className="text-xs text-muted-foreground">{item.role.text}</p>
        </div>
        {readOnly || renaming ? null : (
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(true)} aria-label={`Rename ${item.label}`}>
              <Pencil aria-hidden />
              <span className="max-sm:sr-only">Rename</span>
            </Button>
            {move ? (
              <>
                <RowAction action={itemAction} version={version} fields={{ op: "up", item_id: item.id }} size="icon-sm" variant="ghost"
                  submitLabel={<ArrowUp aria-hidden />} ariaLabel={`Move ${item.label} up`} disabled={move.first} />
                <RowAction action={itemAction} version={version} fields={{ op: "down", item_id: item.id }} size="icon-sm" variant="ghost"
                  submitLabel={<ArrowDown aria-hidden />} ariaLabel={`Move ${item.label} down`} disabled={move.last} />
              </>
            ) : null}
            {item.removable ? (
              <RowAction
                action={itemAction}
                version={version}
                fields={{ op: "remove", item_id: item.id }}
                size="icon-sm"
                variant="ghost"
                submitLabel={<Trash2 aria-hidden />}
                ariaLabel={`Remove ${item.label}`}
                confirmText={item.custom
                  ? `Remove "${item.label}"${removeNote} and ${item.questions ? "its questions" : "everything in it"} from this template? Events already planned with it keep theirs. This can't be undone here.`
                  : `Remove "${item.label}"${removeNote} from this template? Events already planned with it keep theirs. You can add it back later from "Not in this template".`}
              />
            ) : null}
          </div>
        )}
      </div>
      {/* What the client is asked: the full row's width, so editing has room on a phone. */}
          {item.custom && item.questions ? (
            <CustomQuestionsAuthor
              itemId={item.id}
              itemKey={item.key}
              itemLabel={item.label}
              questions={item.questions}
              version={version}
              action={questionsAction}
              readOnly={readOnly}
              defaultOpen={item.questions.length === 0 && !readOnly}
              savedText="Saved. Events whose planning starts from now on get these questions."
            />
          ) : item.summary ? <QuestionList item={item} /> : null}
    </div>
  );
}

const NEED: Record<QuestionSummary["questions"][number]["need"], string> = {
  needed: "Needed",
  optional: "Optional",
  needed_to_complete: "Needed to complete",
};

/**
 * What the client is asked in this item, collapsed until opened: each question's wording, how it is
 * answered and whether it's needed. Built-in questions are read-only; the preview shows the working form.
 */
function QuestionList({ item }: { item: EditorItem }) {
  const [open, setOpen] = useState(false);
  const summary = item.summary!;
  const panel = `questions-${item.key}`;
  const count = summary.questions.length;
  return (
    <div className="grid gap-2" data-testid={`questions-${item.key}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 inline-flex min-h-8 items-center gap-1 justify-self-start rounded-md px-1 text-xs font-medium outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        What clients are asked ({count} {count === 1 ? "question" : "questions"})
        <span className="sr-only"> in {item.label}</span>
      </button>
      <div id={panel} hidden={!open} className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
        {summary.intro ? <p className="text-muted-foreground">{summary.intro}</p> : null}
        <ol className="grid gap-2" aria-label={`Questions in ${item.label}`}>
          {summary.questions.map((q, i) => (
            <li key={i} className="grid gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-medium [overflow-wrap:anywhere]">{q.label}</span>
                <span className={cn("text-xs", q.need === "optional" ? "text-muted-foreground" : "font-medium text-foreground")}>{NEED[q.need]}</span>
              </span>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {q.answer}
                {q.when ? <> · Shown when: {q.when}</> : null}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">Built-in questions can&apos;t be changed. Use Preview to try the client&apos;s form.</p>
      </div>
    </div>
  );
}

function AddPicker({ label, hint, options, version, addAction }: { label: string; hint?: ReactNode; options: { value: string; label: string }[]; version: number; addAction: Action }) {
  const id = `add-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <RowAction action={addAction} version={version} fields={{}} submitLabel="Add" pendingLabel="Adding…" variant="secondary" className="items-end">
      <span className="grid gap-1 text-sm">
        <label htmlFor={id} className="font-medium">{label}</label>
        <select id={id} name="item" required className={cn(selectClass, "w-64 max-w-full")} defaultValue="">
          <option value="" disabled>Choose…</option>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </RowAction>
  );
}
