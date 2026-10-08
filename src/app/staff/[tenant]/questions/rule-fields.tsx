import { SelectField, TextAreaField, TextField } from "@/components/app/fields";
import type { QuestionOption } from "@/lib/catalog/rules";

export type RuleGearChoice = { id: string; name: string; active: boolean; price: string; unit: string };

type Rule = { condition: unknown; gear_item_id: string; required_quantity: number; reason: string };

/**
 * The fields of one rule: which answer triggers it (by answer type), the gear
 * it requires, how many, and the reason clients see. `prefix` keeps field ids
 * unique when several rule forms are on the page.
 */
export function RuleFields({ prefix, answerType, options, gear, rule }: { prefix: string; answerType: string; options: QuestionOption[]; gear: RuleGearChoice[]; rule?: Rule }) {
  const c = (rule?.condition ?? {}) as { op?: string; value?: unknown; values?: string[] };
  const selected = new Set(c.op === "in" ? (c.values ?? []) : typeof c.value === "string" ? [c.value] : []);
  const gearOptions = gear
    .filter((g) => g.active || g.id === rule?.gear_item_id)
    .map((g) => ({ value: g.id, label: `${g.name} · ${g.price} per ${g.unit}${g.active ? "" : " (archived)"}` }));
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <fieldset className="grid min-w-0 gap-1.5 sm:col-span-2">
        <legend className="mb-1 text-sm font-medium">
          {answerType === "multi_choice" ? "When the client’s answers include" : answerType === "single_choice" ? "When the client answers any of" : "When the client answers"}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {answerType === "boolean"
            ? [
                ["true", "Yes"],
                ["false", "No"],
              ].map(([value, label]) => (
                <label key={value} className="flex items-center gap-2">
                  <input type="radio" name="when" value={value} required defaultChecked={c.op === "equals" && String(c.value) === value} className="size-4 accent-primary" />
                  {label}
                </label>
              ))
            : options.map((o) => (
                <label key={o.value} className="flex items-center gap-2">
                  <input
                    type={answerType === "multi_choice" ? "radio" : "checkbox"}
                    name={answerType === "multi_choice" ? "contains" : "values"}
                    value={o.value}
                    required={answerType === "multi_choice"}
                    defaultChecked={selected.has(o.value)}
                    className="size-4 accent-primary"
                  />
                  {o.label}
                </label>
              ))}
        </div>
      </fieldset>
      <SelectField
        id={`${prefix}-gear`}
        label="Require this gear"
        name="gear_item_id"
        required
        defaultValue={rule?.gear_item_id ?? ""}
        options={gearOptions}
        placeholder="Choose gear"
      />
      <TextField
        id={`${prefix}-quantity`}
        label="Quantity"
        name="required_quantity"
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        required
        defaultValue={rule?.required_quantity ?? 1}
        hint="Adds this many to the total the client must take. Units their package already includes count toward that total."
      />
      <TextAreaField
        id={`${prefix}-reason`}
        className="sm:col-span-2"
        label="Reason shown to the client"
        name="reason"
        rows={2}
        maxLength={500}
        required
        defaultValue={rule?.reason ?? ""}
        placeholder="Your ceremony is in a separate space, so it needs its own speaker."
      />
    </div>
  );
}
