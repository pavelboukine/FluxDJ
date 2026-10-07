"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ActionForm } from "@/components/app/action-form";
import { BrandLogo } from "@/components/app/brand-logo";
import { Field } from "@/components/app/fields";
import { Input } from "@/components/ui/input";
import { brandTheme, DEFAULT_BRAND_COLOR, normalizeHex } from "@/lib/branding/colors";
import type { ActionState } from "@/lib/forms";

type Logo = { url: string; needsDarkBackground: boolean } | null;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Owner branding form with a live preview. The preview shows the chosen file
 * from this device before anything is uploaded; on save the server verifies
 * and re-encodes it. Nothing here sends email or touches client records.
 */
export function BrandingForm({
  action,
  version,
  displayName,
  currentLogo,
  currentColor,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  version: number;
  displayName: string;
  currentLogo: Logo;
  currentColor: string | null;
}) {
  const [color, setColor] = useState(currentColor ?? "");
  const [chosen, setChosen] = useState<{ url: string; name: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (chosen) URL.revokeObjectURL(chosen.url); }, [chosen]);

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setFileError(null);
    if (chosen) URL.revokeObjectURL(chosen.url);
    setChosen(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setFileError("The logo must be 4 MB or smaller.");
      event.target.value = "";
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFileError("Choose a PNG, JPEG or WebP image. SVG isn't supported.");
      event.target.value = "";
      return;
    }
    setRemove(false);
    setChosen({ url: URL.createObjectURL(file), name: file.name });
  }

  const typed = normalizeHex(color);
  const theme = brandTheme(typed ?? DEFAULT_BRAND_COLOR);
  const previewLogo: Logo = remove ? null : chosen ? { url: chosen.url, needsDarkBackground: false } : currentLogo;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <ActionForm
        action={action}
        version={version}
        submitLabel="Save branding"
        pendingLabel={chosen ? "Uploading and saving…" : "Saving…"}
        onSuccess={() => {
          // The saved logo now comes from the server; clear the local file.
          setChosen(null);
          setRemove(false);
          if (fileInput.current) fileInput.current.value = "";
        }}
      >
        <Field label="Logo" htmlFor="logo" hint="PNG, JPEG or WebP, up to 4 MB and 8000 pixels a side. Transparent backgrounds are kept. It is shown without stretching or cropping.">
          <Input ref={fileInput} id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} />
        </Field>
        {fileError ? <p role="alert" className="text-sm text-destructive">{fileError}</p> : null}
        {currentLogo && !chosen ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="remove_logo" checked={remove} onChange={(e) => setRemove(e.target.checked)} className="accent-primary" />
            Remove the logo (show the business name instead)
          </label>
        ) : null}
        <Field label="Primary colour" htmlFor="primary_color" hint="Used for buttons and accents on your client pages. Leave empty for the default dark grey.">
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick the primary colour"
              value={typed ?? DEFAULT_BRAND_COLOR}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
            />
            <Input id="primary_color" name="primary_color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#111827" maxLength={7} className="w-32 font-mono" />
          </div>
        </Field>
        {color !== "" && !typed ? <p role="alert" className="text-sm text-destructive">Enter the colour as a hex value like #1a2b3c.</p> : null}
        <p className="text-xs text-muted-foreground" data-testid="contrast-note">
          Button text on this colour: {theme.foreground === "#ffffff" ? "white" : "dark"} (contrast {theme.foregroundContrast.toFixed(1)}:1).
          {theme.contrastOnWhite < 3 ? " This colour is light, so accents on white pages will be subtle." : ""}
        </p>
      </ActionForm>

      <section aria-label="Client page preview" className="grid content-start gap-3 rounded-xl border border-dashed p-4" data-testid="branding-preview">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Preview · not saved, nothing is sent</p>
        <div className="grid gap-3 rounded-2xl border bg-background p-3 text-sm">
          <header className="grid gap-2 rounded-xl p-4" style={{ background: theme.color, color: theme.foreground }}>
            <div className="flex min-h-10 items-center">
              <BrandLogo logo={previewLogo} name={displayName} className="max-h-12 max-w-48" fallbackClassName="text-xs tracking-wide uppercase opacity-90" />
            </div>
            <p className="text-lg font-semibold">Alex &amp; Sam Wedding</p>
            <p className="opacity-90">Saturday, June 12, 2027 · Sample venue</p>
          </header>
          <div className="grid gap-2 rounded-xl border-2 p-3" style={{ borderColor: theme.color }}>
            <p className="font-medium">Sample package · Signature</p>
            <p className="text-muted-foreground">An example of how a proposal looks to your clients.</p>
            <span className="inline-flex w-fit rounded-lg px-3 py-2 font-medium" style={{ background: theme.color, color: theme.foreground }}>
              Submit my selection
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
