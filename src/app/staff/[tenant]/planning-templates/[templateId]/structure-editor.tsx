"use client";

import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/app/fields";
import { RowAction } from "@/components/planning/row-action";
import type { ActionState } from "@/lib/forms";
import type { ItemRole, LibraryEntry } from "@/lib/planning/template-structure";
import { cn } from "@/lib/utils";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export type EditorItem = { id: string; key: string; label: string; removable: boolean; role: ItemRole };
export type EditorStage = EditorItem & { moments: EditorItem[]; addable: LibraryEntry[] };

type Props = {
  general: EditorItem[];
  stages: EditorStage[];
  addableGeneral: LibraryEntry[];
  addableStages: LibraryEntry[];
  version: number;
  itemAction: Action;
  addAction: Action;
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
export function TemplateStructureEditor({ general, stages, addableGeneral, addableStages, version, itemAction, addAction, readOnly }: Props) {
  const common = { version, itemAction, readOnly };
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
                <StageBlock stage={s} index={i} count={stages.length} addAction={addAction} {...common} />
              </li>
            ))}
          </ol>
        )}
        {!readOnly && addableStages.length > 0 ? (
          <AddPicker label="Add a stage" hint="New stages go last; move them into place." options={addableStages.map((l) => ({ value: l.key, label: l.default_label }))} version={version} addAction={addAction} />
        ) : null}
      </section>
    </div>
  );
}

type Common = { version: number; itemAction: Action; readOnly: boolean };

function StageBlock({ stage, index, count, addAction, ...common }: Common & { stage: EditorStage; index: number; count: number; addAction: Action }) {
  const [open, setOpen] = useState(false);
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
      </div>
    </div>
  );
}

function ItemRow({ item, number, move, removeNote = "", version, itemAction, readOnly }: Common & {
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
                confirmText={`Remove "${item.label}"${removeNote} from this template? Events already planned with it keep theirs. You can add it back later from "Not in this template".`}
              />
            ) : null}
          </div>
        )}
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
