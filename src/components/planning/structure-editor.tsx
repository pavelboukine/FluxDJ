import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { selectClass } from "@/components/app/fields";
import type { ActionState } from "@/lib/forms";
import { RowAction } from "./row-action";

type Action = (state: ActionState, formData: FormData) => Promise<ActionState>;

export type StructureItem = { id: string; key: string; label: string; disabled: boolean; editor: string | null; removable: boolean };
export type StructureStage = StructureItem & { moments: StructureItem[] };
export type LibraryRow = { kind: string; key: string; parent_keys: string[] | null; default_label: string; description: string | null };

type Props = {
  /** template: items are removed. plan: items are hidden and restored, keeping answers. */
  mode: "template" | "plan";
  general: StructureItem[];
  stages: StructureStage[];
  version: number;
  itemAction: Action;
  addAction: Action;
  library: LibraryRow[];
  readOnly?: boolean;
};

/**
 * Small, explicit structure controls: rename, Move up / Move down, remove
 * (templates) or hide / restore (event plans), and add from the library.
 * Items are identified by id and library key, never by label.
 */
export function StructureEditor({ mode, general, stages, version, itemAction, addAction, library, readOnly }: Props) {
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

  const row = (item: StructureItem, opts: { movable: boolean; first: boolean; last: boolean; childCount?: number }) => (
    <div className={`flex flex-wrap items-center gap-2 ${item.disabled ? "opacity-70" : ""}`} data-testid={`row-${item.key}`}>
      <RowAction action={itemAction} version={version} fields={{ op: "rename", item_id: item.id }} submitLabel="Rename" ariaLabel={`Rename ${item.label}`} disabled={readOnly}>
        <Input name="label" defaultValue={item.label} maxLength={120} required aria-label={`Label for ${item.label}`} className="h-8 w-48 sm:w-64" disabled={readOnly} />
      </RowAction>
      {opts.movable ? (
        <>
          <RowAction action={itemAction} version={version} fields={{ op: "up", item_id: item.id }} submitLabel="Move up" ariaLabel={`Move ${item.label} up`} disabled={readOnly || opts.first} pendingLabel="Moving…" />
          <RowAction action={itemAction} version={version} fields={{ op: "down", item_id: item.id }} submitLabel="Move down" ariaLabel={`Move ${item.label} down`} disabled={readOnly || opts.last} pendingLabel="Moving…" />
        </>
      ) : null}
      {item.removable && mode === "template" ? (
        <RowAction
          action={itemAction}
          version={version}
          fields={{ op: "remove", item_id: item.id }}
          submitLabel="Remove"
          ariaLabel={`Remove ${item.label}`}
          variant="ghost"
          disabled={readOnly}
          confirmText={`Remove "${item.label}"${opts.childCount ? ` and its ${opts.childCount} moments` : ""} from this template? Events already planned with it keep theirs.`}
        />
      ) : null}
      {item.removable && mode === "plan" ? (
        item.disabled ? (
          <RowAction action={itemAction} version={version} fields={{ op: "restore", item_id: item.id }} submitLabel="Restore" ariaLabel={`Restore ${item.label}`} disabled={readOnly} />
        ) : (
          <RowAction action={itemAction} version={version} fields={{ op: "hide", item_id: item.id }} submitLabel="Hide" ariaLabel={`Hide ${item.label} from the client`} variant="ghost" disabled={readOnly} />
        )
      ) : null}
      {item.disabled ? <Badge variant="secondary">Hidden from the client</Badge> : null}
      {item.editor ? <Badge variant="outline">Editor available</Badge> : <Badge variant="outline">Not available yet</Badge>}
      <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
    </div>
  );

  return (
    <div className="grid gap-6">
      <section className="grid gap-2" aria-labelledby={`${mode}-general`}>
        <h3 id={`${mode}-general`} className="text-sm font-semibold">General sections</h3>
        <ul className="grid gap-2">
          {general.map((g) => (
            <li key={g.id} className="rounded-lg border p-2">{row(g, { movable: false, first: true, last: true })}</li>
          ))}
        </ul>
      </section>
      <section className="grid gap-2" aria-labelledby={`${mode}-stages`}>
        <h3 id={`${mode}-stages`} className="text-sm font-semibold">Stages, in event order</h3>
        {stages.length === 0 ? <p className="text-sm text-muted-foreground">No stages yet. Add one below.</p> : null}
        <ol className="grid gap-3">
          {stages.map((s, i) => (
            <li key={s.id} className="grid gap-2 rounded-lg border p-2">
              {row(s, { movable: true, first: i === 0, last: i === stages.length - 1, childCount: s.moments.length })}
              {s.moments.length > 0 ? (
                <ol className="grid gap-2 border-l-2 pl-3 sm:ml-4" aria-label={`Moments in ${s.label}`}>
                  {s.moments.map((m, j) => (
                    <li key={m.id}>{row(m, { movable: true, first: j === 0, last: j === s.moments.length - 1 })}</li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      {!readOnly && (addable.general.length > 0 || addable.stage.length > 0 || addable.moment.length > 0) ? (
        <RowAction action={addAction} version={version} fields={{}} submitLabel="Add" pendingLabel="Adding…" variant="secondary">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Add from the library</span>
            <select name="item" required className={`${selectClass} w-72 max-w-full`} defaultValue="">
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
