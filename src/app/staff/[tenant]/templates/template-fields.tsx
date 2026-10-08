import { FieldGroup } from "@/components/app/catalog-fields";
import { TextAreaField, TextField } from "@/components/app/fields";

type Details = { name: string; intro: string | null; expiry_days: number };

/** A template's own details: its name, the intro clients read, and (unless shown separately) how long proposals stay open. */
export function TemplateDetailsFields({
  template,
  withSettings = true,
}: {
  template?: Details;
  withSettings?: boolean;
}) {
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">
        All fields are required unless marked optional.
      </p>
      <FieldGroup legend="Name and intro">
        <TextField
          label="Name"
          name="name"
          required
          maxLength={200}
          defaultValue={template?.name}
          placeholder="Wedding"
          className="sm:col-span-2"
          hint="For your team; clients don't see it."
        />
        <TextAreaField
          className="sm:col-span-2"
          label="Intro shown to clients (optional)"
          name="intro"
          rows={3}
          maxLength={10000}
          defaultValue={template?.intro ?? ""}
          hint="Opens the proposal. You can still change it on each proposal."
        />
      </FieldGroup>
      {withSettings ? <TemplateSettingsFields template={template} /> : null}
    </div>
  );
}

export function TemplateSettingsFields({ template }: { template?: Details }) {
  return (
    <FieldGroup legend="Other settings">
      <TextField
        label="Proposal expiry (days)"
        name="expiry_days"
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        required
        defaultValue={template?.expiry_days ?? 14}
        hint="How long the client has to submit, counted from sending. 1 to 365."
      />
    </FieldGroup>
  );
}
