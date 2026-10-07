"use client";

import { useState } from "react";
import { ActionForm } from "@/components/app/action-form";
import { TextField } from "@/components/app/fields";
import { slugFromName, type ActionState } from "@/lib/forms";

/** Business name and web address. Typed values stay after a failed attempt. */
export function WorkspaceForm({ action, host }: { action: (state: ActionState, form: FormData) => Promise<ActionState>; host: string }) {
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  return (
    <ActionForm action={action} submitLabel="Create my workspace" pendingLabel="Creating…">
      <TextField
        label="Business name"
        name="display_name"
        required
        minLength={2}
        maxLength={100}
        autoComplete="organization"
        hint="The name your clients see on proposals and emails. You can add your legal business name later in Settings."
        onChange={(e) => {
          if (!edited) setSlug(slugFromName(e.target.value));
        }}
      />
      <TextField
        label="Web address"
        name="slug"
        required
        minLength={3}
        maxLength={48}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={slug}
        onChange={(e) => {
          setEdited(true);
          setSlug(e.target.value.toLowerCase());
        }}
        hint={
          <>
            Your client pages live at {host}/<strong>{slug || "your-name"}</strong>. Lowercase letters, numbers and hyphens. It can&apos;t be
            changed later.
          </>
        }
      />
    </ActionForm>
  );
}
