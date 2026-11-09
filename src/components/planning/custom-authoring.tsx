"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/app/fields";
import { useSharedDraftVersion } from "@/components/app/draft-version";
import { idleState, type ActionState } from "@/lib/forms";
import {
  CUSTOM_QUESTION_TYPES,
  CUSTOM_TYPE_LABEL,
  QUESTION_LIMITS,
  draftProblem,
  draftsFromQuestions,
  draftsToPayload,
  isChoiceType,
  newDraftKey,
  newQuestionDraft,
  withType,
  type CustomQuestion,
  type DraftProblem,
  type QuestionDraft,
} from "@/lib/planning/custom-questions";
import { RowAction } from "./row-action";
import { cn } from "@/lib/utils";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

const NOUN = { general: "section", stage: "stage", moment: "moment" } as const;

/**
 * "Create your own section / stage / moment": a name, then the item exists (with no questions yet).
 * One small version-checked request, like every structure change. Shared by planning templates and
 * an event's planning.
 */
export function CreateOwnItem({ kind, parentKey, parentLabel, version, action }: {
  kind: "general" | "stage" | "moment";
  /** The stage a moment goes in (its key). */
  parentKey?: string;
  parentLabel?: string;
  version: number;
  action: Action;
}) {
  const [open, setOpen] = useState(false);
  const noun = NOUN[kind];
  const where = parentLabel ? ` in ${parentLabel}` : "";
  if (!open) {
    return (
      <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => setOpen(true)} aria-label={`Create your own ${noun}${where}`}>
        <Plus aria-hidden />
        Create your own {noun}
      </Button>
    );
  }
  return (
    <RowAction
      action={action}
      version={version}
      fields={{ kind, ...(parentKey ? { parent_key: parentKey } : {}) }}
      submitLabel={`Create ${noun}`}
      pendingLabel="Creating…"
      variant="secondary"
      onSuccess={() => setOpen(false)}
      className="w-full"
    >
      <Input
        name="label"
        required
        maxLength={120}
        autoFocus
        placeholder={kind === "general" ? "For example: Cultural music" : kind === "stage" ? "For example: Cultural set" : "For example: Hora"}
        aria-label={`Name of the new ${noun}${where}`}
        className="min-w-0 flex-1 sm:max-w-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </RowAction>
  );
}

/**
 * "Your questions" for a DJ's own section or moment: collapsed until opened, then the questions in
 * order, each opening into a small editor (one at a time). Changes stay in the browser until "Save
 * questions", which sends the whole list with the version this page knows, so another tab's change
 * is a conflict, never overwritten. On an event's plan, questions that already hold answers keep
 * their type, and removing a question or a choice keeps the answers given (the database keeps them,
 * archived, for staff). Removed questions are never offered here for editing.
 */
export function CustomQuestionsAuthor({ itemId, itemKey, itemLabel, questions, answered = [], version, action, readOnly, defaultOpen, savedText }: {
  itemId: string;
  itemKey: string;
  itemLabel: string;
  /** The stored definitions (archived ones are left out of the editor). */
  questions: CustomQuestion[];
  /** Question ids that already hold an answer (an event's plan; none on a template). */
  answered?: string[];
  version: number;
  action: Action;
  readOnly: boolean;
  defaultOpen?: boolean;
  /** What a save means here ("Saved. New event plans from this template use them."). */
  savedText: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => draftsFromQuestions(questions));
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [result, setResult] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  const shared = useSharedDraftVersion();
  const saved = useRef<number | undefined>(undefined);
  const panel = `author-panel-${itemKey}`;
  const answeredIds = new Set(answered);
  const removedKept = questions.filter((q) => q.archived).length;

  // New questions from the server (after a save here, or a reload): start again from them.
  const serverKey = JSON.stringify(questions);
  const [base, setBase] = useState(serverKey);
  if (serverKey !== base) {
    setBase(serverKey);
    setDrafts(draftsFromQuestions(questions));
    setProblem(null);
  }
  const dirty = JSON.stringify(draftsToPayload(drafts)) !== JSON.stringify(draftsToPayload(draftsFromQuestions(questions)));

  // Leaving the page with unsaved questions asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function change(next: QuestionDraft[]) {
    setDrafts(next);
    setResult(idleState);
    if (problem) setProblem(draftProblem(next));
  }
  const update = (key: string, changes: Partial<QuestionDraft>) => change(drafts.map((d) => (d.key === key ? { ...d, ...changes } : d)));
  function move(index: number, by: -1 | 1) {
    const next = [...drafts];
    const [d] = next.splice(index, 1);
    next.splice(index + by, 0, d);
    change(next);
  }
  function remove(d: QuestionDraft) {
    if (d.id && answeredIds.has(d.id)
      && !window.confirm(`Remove "${d.label || "this question"}"? Answers already given are kept and stay visible to you; your client won't see this question any more.`)) return;
    change(drafts.filter((x) => x.key !== d.key));
    setEditing(null);
  }
  function add() {
    const d = newQuestionDraft();
    change([...drafts, d]);
    setEditing(d.key);
  }
  function save() {
    const found = draftProblem(drafts);
    setProblem(found);
    if (found) {
      setEditing(found.question);
      return;
    }
    const data = new FormData();
    data.set("item_id", itemId);
    data.set("questions", JSON.stringify(draftsToPayload(drafts)));
    data.set("draft_version", String(Math.max(version, saved.current ?? version, shared?.current ?? version)));
    start(async () => {
      const r = await action(result, data);
      setResult(r);
      if (r.status === "success") {
        setEditing(null);
        if (r.version !== undefined) {
          saved.current = r.version;
          if (shared) shared.current = Math.max(shared.current, r.version);
        }
      }
    });
  }

  const count = drafts.length;
  return (
    <div className="grid gap-2" data-testid={`author-${itemKey}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 inline-flex min-h-8 items-center gap-1 justify-self-start rounded-md px-1 text-xs font-medium outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
        Your questions ({count} {count === 1 ? "question" : "questions"})
        <span className="sr-only"> in {itemLabel}</span>
        {dirty ? <span className="font-normal text-muted-foreground">· Not saved</span> : null}
      </button>
      <div id={panel} hidden={!open} className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
        {count === 0 ? (
          <p className="text-muted-foreground">No questions yet. Clients see this {itemLabel ? `"${itemLabel}"` : "item"} once it has at least one.</p>
        ) : (
          <ol className="-mx-3 -mt-3 grid divide-y border-b" aria-label={`Your questions in ${itemLabel}`}>
            {drafts.map((d, i) => {
              const isAnswered = Boolean(d.id && answeredIds.has(d.id));
              const isOpen = editing === d.key && !readOnly;
              const name = d.label.trim() || "New question";
              const flagged = problem?.question === d.key;
              return (
                <li key={d.key} className={cn("grid gap-3 px-3 py-2.5", isOpen && "bg-background")} data-testid="author-question">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="font-medium [overflow-wrap:anywhere]" data-testid="author-question-label">
                        <span className="font-normal text-muted-foreground tabular-nums">{i + 1}. </span>
                        {d.label.trim() || <span className="text-muted-foreground">New question</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>{CUSTOM_TYPE_LABEL[d.type]}{isChoiceType(d.type) ? `: ${d.options.map((o) => o.label.trim()).filter(Boolean).join(" · ") || "no choices yet"}` : ""}</span>
                        <span className={d.required ? "font-medium text-foreground" : undefined}>{d.required ? "Needed" : "Optional"}</span>
                        {isAnswered ? <Badge variant="secondary">Has answers</Badge> : null}
                      </span>
                      {flagged && !isOpen ? <p role="alert" className="text-xs text-destructive">{problem.message}</p> : null}
                    </div>
                    {readOnly ? null : (
                      <div className="flex items-center gap-1">
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp aria-hidden /></Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} down`} disabled={i === count - 1} onClick={() => move(i, 1)}><ArrowDown aria-hidden /></Button>
                        <Button type="button" size="sm" variant="ghost" aria-expanded={isOpen} aria-label={isOpen ? `Done editing ${name}` : `Edit ${name}`} onClick={() => setEditing(isOpen ? null : d.key)}>
                          <Pencil aria-hidden />
                          <span className="max-sm:sr-only">{isOpen ? "Done" : "Edit"}</span>
                        </Button>
                      </div>
                    )}
                  </div>
                  {isOpen ? (
                    <QuestionFields
                      draft={d}
                      answered={isAnswered}
                      problem={flagged ? problem : null}
                      onChange={(changes) => update(d.key, changes)}
                      onRemove={() => remove(d)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {readOnly ? null : (
          <>
            {count < QUESTION_LIMITS.questions ? (
              <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={add}>
                <Plus aria-hidden />
                Add a question
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">This has the maximum of {QUESTION_LIMITS.questions} questions.</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
              <Button type="button" size="sm" onClick={save} disabled={pending || !dirty}>
                {pending ? "Saving…" : "Save questions"}
              </Button>
              {dirty && !pending ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => { setDrafts(draftsFromQuestions(questions)); setProblem(null); setEditing(null); setResult(idleState); }}>
                  Discard changes
                </Button>
              ) : null}
              <p
                role={result.status === "error" || problem ? "alert" : "status"}
                data-testid="author-status"
                className={cn("text-xs", result.status === "error" || problem ? "font-medium text-destructive" : "text-muted-foreground")}
              >
                {result.status === "error" ? result.message
                  : problem ? `Not saved: ${problem.message}`
                  : pending ? null
                  : dirty ? "Unsaved changes"
                  : result.status === "success" ? savedText
                  : null}
              </p>
            </div>
          </>
        )}
        {removedKept > 0 ? (
          <p className="text-xs text-muted-foreground">
            {removedKept === 1 ? "1 removed question is" : `${removedKept} removed questions are`} kept with the answers given, shown to you under the section&apos;s answers.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** One question's settings: wording, type, help, needed, and its choices. */
function QuestionFields({ draft, answered, problem, onChange, onRemove }: {
  draft: QuestionDraft;
  answered: boolean;
  problem: DraftProblem | null;
  onChange: (changes: Partial<QuestionDraft>) => void;
  onRemove: () => void;
}) {
  const base = `q-${draft.key.replace(/\W/g, "")}`;
  const error = (field: DraftProblem["field"]) => (problem && problem.field === field && !problem.option ? problem.message : null);
  const setOption = (key: string, label: string) => onChange({ options: draft.options.map((o) => (o.key === key ? { ...o, label } : o)) });
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <label htmlFor={`${base}-label`} className="text-sm font-medium">Question</label>
        <Input id={`${base}-label`} value={draft.label} maxLength={QUESTION_LIMITS.label} autoFocus={!draft.label}
          aria-invalid={Boolean(error("label"))} onChange={(e) => onChange({ label: e.target.value })} />
        {error("label") ? <p className="text-xs text-destructive">{error("label")}</p> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor={`${base}-type`} className="text-sm font-medium">Answer type</label>
          <select id={`${base}-type`} className={cn(selectClass, "w-full")} value={draft.type} disabled={answered}
            aria-describedby={answered ? `${base}-type-hint` : undefined}
            onChange={(e) => onChange(withType(draft, e.target.value as QuestionDraft["type"]))}>
            {CUSTOM_QUESTION_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_TYPE_LABEL[t]}</option>)}
          </select>
          {answered ? <p id={`${base}-type-hint`} className="text-xs text-muted-foreground">It already has answers, so its type stays. Add a new question for a different type.</p> : null}
        </div>
        <label className="flex min-h-11 items-center gap-2 self-end text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={draft.required} onChange={(e) => onChange({ required: e.target.checked })} />
          Needed to complete planning
        </label>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${base}-help`} className="text-sm font-medium">Help text <span className="font-normal text-muted-foreground">(optional)</span></label>
        <Input id={`${base}-help`} value={draft.help} maxLength={QUESTION_LIMITS.help} placeholder="Shown under the question"
          aria-invalid={Boolean(error("help"))} onChange={(e) => onChange({ help: e.target.value })} />
        {error("help") ? <p className="text-xs text-destructive">{error("help")}</p> : null}
      </div>
      {isChoiceType(draft.type) ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Choices</legend>
          <ol className="grid gap-2">
            {draft.options.map((o, i) => {
              const optionError = problem?.option === o.key ? problem.message : null;
              return (
                <li key={o.key} className="grid gap-1">
                  <div className="flex items-center gap-2">
                    <Input value={o.label} maxLength={QUESTION_LIMITS.option} aria-label={`Choice ${i + 1}`} aria-invalid={Boolean(optionError)}
                      className="min-w-0 flex-1" onChange={(e) => setOption(o.key, e.target.value)} />
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove choice ${i + 1}${o.label.trim() ? ` (${o.label.trim()})` : ""}`}
                      disabled={draft.options.length <= QUESTION_LIMITS.optionsMin}
                      onClick={() => onChange({ options: draft.options.filter((x) => x.key !== o.key) })}>
                      <X aria-hidden />
                    </Button>
                  </div>
                  {optionError ? <p className="text-xs text-destructive">{optionError}</p> : null}
                </li>
              );
            })}
          </ol>
          {error("options") ? <p className="text-xs text-destructive">{error("options")}</p> : null}
          {draft.options.length < QUESTION_LIMITS.optionsMax ? (
            <Button type="button" size="sm" variant="ghost" className="justify-self-start"
              onClick={() => onChange({ options: [...draft.options, { key: newDraftKey(), label: "" }] })}>
              <Plus aria-hidden />
              Add a choice
            </Button>
          ) : null}
          {answered ? <p className="text-xs text-muted-foreground">Removing a choice someone already picked keeps their answer.</p> : null}
        </fieldset>
      ) : null}
      <Button type="button" size="sm" variant="ghost" className="justify-self-start text-destructive hover:text-destructive" onClick={onRemove}>
        <Trash2 aria-hidden />
        Remove question
      </Button>
      {answered ? <p className="-mt-2 text-xs text-muted-foreground">Removing it keeps the answers already given; your client stops seeing it.</p> : null}
    </div>
  );
}
