"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/app/fields";
import type { ActionState } from "@/lib/forms";
import type { CustomQuestion } from "@/lib/planning/custom-questions";
import { isCustomKey } from "@/lib/planning/template-structure";
import { cn } from "@/lib/utils";
import { CreateOwnItem, CustomQuestionsAuthor } from "./custom-authoring";
import { RowAction } from "./row-action";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

/** `questions`: a DJ's own section's or moment's questions (archived ones included, for the count of kept answers). */
export type StructureItem = { id: string; key: string; label: string; disabled: boolean; editor: string | null; removable: boolean; questions?: CustomQuestion[] };
export type StructureStage = StructureItem & { moments: StructureItem[] };
export type LibraryRow = { kind: string; key: string; parent_keys: string[] | null; default_label: string; description: string | null };

type Props = {
  general: StructureItem[];
  stages: StructureStage[];
  version: number;
  itemAction: Action;
  addAction: Action;
  library: LibraryRow[];
  /** Creates the DJ's own section, stage or moment for this event only. */
  customAction: Action;
  /** Saves a custom item's questions on this plan. */
  questionsAction: Action;
  /** Question ids that already hold an answer, by item id (their type can't change). */
  answered: Record<string, string[]>;
  readOnly?: boolean;
};

type Common = { version: number; itemAction: Action; questionsAction: Action; answered: Record<string, string[]>; readOnly: boolean };

/**
 * An event plan's structure, laid out like the planning template editor: general sections in one
 * list, then the stages in event order, each with its moments. Rename, move, hide / restore (keeping
 * answers), add from the library, and the DJ's own sections, stages and moments with their
 * questions (the same authoring components as templates, for this event only). Every change is
 * its own small version-checked request, so a stale tab gets a conflict instead of overwriting.
 * Items are identified by id and key, never by label; keys are never shown.
 */
export function StructureEditor({ general, stages, version, itemAction, addAction, library, customAction, questionsAction, answered, readOnly = false }: Props) {
  const present = new Set([...general.map((g) => g.key), ...stages.flatMap((s) => [s.key, ...s.moments.map((m) => m.key)])]);
  const stageByKey = new Map(stages.map((s) => [s.key, s]));
  const addable = {
    general: library.filter((l) => l.kind === "general" && !present.has(l.key)),
    stage: library.filter((l) => l.kind === "stage" && !present.has(l.key)),
    moment: library.flatMap((l) =>
      l.kind !== "moment" || present.has(l.key)
        ? []
        : (l.parent_keys ?? [])
            .map((pk) => stageByKey.get(pk))
            .filter((s): s is StructureStage => Boolean(s) && !s!.disabled)
            .map((s) => ({ value: `${l.key}|${s.key}`, label: `${l.default_label} (in ${s.label})` })),
    ),
  };
  const common: Common = { version, itemAction, questionsAction, answered, readOnly };

  return (
    <div className="grid gap-8">
      <section aria-labelledby="plan-general" className="grid gap-3">
        <div className="grid gap-1">
          <h3 id="plan-general" className="text-base font-semibold">General sections</h3>
          <p className="text-sm text-muted-foreground">The client sees these first, under &ldquo;Event details&rdquo;. They keep their order.</p>
        </div>
        <ul className="grid divide-y rounded-xl border bg-card" aria-label="General sections">
          {general.map((g) => (
            <li key={g.id} className="p-3 sm:px-4" data-testid={`row-${g.key}`}>
              <ItemRow item={g} {...common} />
            </li>
          ))}
        </ul>
        {!readOnly ? <CreateOwnItem kind="general" version={version} action={customAction} /> : null}
      </section>

      <section aria-labelledby="plan-stages" className="grid gap-3">
        <div className="grid gap-1">
          <h3 id="plan-stages" className="text-base font-semibold">Stages, in event order</h3>
          <p className="text-sm text-muted-foreground">Each stage holds its moments. Hiding a stage hides its moments too.</p>
        </div>
        {stages.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No stages yet.</p>
        ) : (
          <ol className="grid gap-3" aria-label="Stages, in event order">
            {stages.map((s, i) => (
              <li key={s.id} className={cn("grid min-w-0 rounded-xl border bg-card", s.disabled && "bg-muted/30")} data-testid={`stage-${s.key}`}>
                <div className="p-3 sm:px-4" data-testid={`row-${s.key}`}>
                  <ItemRow item={s} number={i + 1} move={{ first: i === 0, last: i === stages.length - 1 }} {...common} />
                </div>
                <div className="grid gap-3 border-t bg-muted/20 p-3 sm:px-4">
                  {s.moments.length > 0 ? (
                    <ol className="grid divide-y rounded-lg border bg-card" aria-label={`Moments in ${s.label}`}>
                      {s.moments.map((m, j) => (
                        <li key={m.id} className="p-3" data-testid={`row-${m.key}`}>
                          <ItemRow item={m} move={{ first: j === 0, last: j === s.moments.length - 1 }} {...common} />
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">No moments in this stage yet.</p>
                  )}
                  {!readOnly && !s.disabled ? <CreateOwnItem kind="moment" parentKey={s.key} parentLabel={s.label} version={version} action={customAction} /> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {!readOnly ? <CreateOwnItem kind="stage" version={version} action={customAction} /> : null}
      </section>

      {!readOnly && (addable.general.length > 0 || addable.stage.length > 0 || addable.moment.length > 0) ? (
        <RowAction action={addAction} version={version} fields={{}} submitLabel="Add" pendingLabel="Adding…" variant="secondary" className="items-end">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Add from the library</span>
            <select name="item" required className={cn(selectClass, "w-72 max-w-full")} defaultValue="">
              <option value="" disabled>— choose —</option>
              {addable.general.length > 0 ? (
                <optgroup label="General sections">
                  {addable.general.map((l) => <option key={l.key} value={l.key}>{l.default_label}</option>)}
                </optgroup>
              ) : null}
              {addable.stage.length > 0 ? (
                <optgroup label="Stages">
                  {addable.stage.map((l) => <option key={l.key} value={l.key}>{l.default_label}</option>)}
                </optgroup>
              ) : null}
              {addable.moment.length > 0 ? (
                <optgroup label="Moments">
                  {addable.moment.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              ) : null}
            </select>
          </label>
        </RowAction>
      ) : null}
    </div>
  );
}

/** One section, stage or moment: its name and state, its actions, and (the DJ's own) its questions at full width. */
function ItemRow({ item, number, move, version, itemAction, questionsAction, answered, readOnly }: Common & {
  item: StructureItem;
  number?: number;
  move?: { first: boolean; last: boolean };
}) {
  const [renaming, setRenaming] = useState(false);
  const custom = isCustomKey(item.key);
  return (
    <div className={cn("grid gap-2", item.disabled && "opacity-80")}>
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
              {item.disabled ? <Badge variant="secondary">Hidden from the client</Badge> : null}
              {custom ? <Badge variant="secondary">Your own</Badge> : null}
            </span>
          )}
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
              item.disabled ? (
                <RowAction action={itemAction} version={version} fields={{ op: "restore", item_id: item.id }} submitLabel="Restore" ariaLabel={`Restore ${item.label}`} variant="ghost" />
              ) : (
                <RowAction action={itemAction} version={version} fields={{ op: "hide", item_id: item.id }} submitLabel="Hide" ariaLabel={`Hide ${item.label} from the client`} variant="ghost" />
              )
            ) : null}
          </div>
        )}
      </div>
      {custom && item.questions ? (
        <CustomQuestionsAuthor
          itemId={item.id}
          itemKey={item.key}
          itemLabel={item.label}
          questions={item.questions}
          answered={answered[item.id] ?? []}
          version={version}
          action={questionsAction}
          readOnly={readOnly}
          defaultOpen={item.questions.length === 0 && !readOnly}
          savedText="Saved. Your client sees these questions once planning is open to them."
        />
      ) : null}
    </div>
  );
}
