"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { CircleUserRound, Menu } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { BrandLogo } from "@/components/app/brand-logo";
import { Field } from "@/components/app/fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandTheme, DEFAULT_BRAND_COLOR, normalizeHex } from "@/lib/branding/colors";
import { CLIENT_PAGE_LOGO, LOGO_SIZE, logoSizeLabel, STAFF_HEADER_LOGO_HEIGHT } from "@/lib/branding/logo-size";
import type { ActionState } from "@/lib/forms";
import type { LogoPreview } from "./actions";

type Logo = { url: string; needsDarkBackground: boolean } | null;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Owner branding form with a live preview. The preview shows the chosen file
 * from this device before anything is uploaded; on save the server verifies
 * and re-encodes it. Nothing here sends email or touches client records.
 */
export function BrandingForm({
  action,
  preview,
  version,
  displayName,
  currentLogo,
  currentColor,
  currentSize,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  /** Runs the save's own image processing without storing anything, so the preview shows the logo as it will be saved. */
  preview: (form: FormData) => Promise<LogoPreview>;
  version: number;
  displayName: string;
  currentLogo: Logo;
  currentColor: string | null;
  currentSize: number;
}) {
  const [color, setColor] = useState(currentColor ?? "");
  const [size, setSize] = useState(currentSize);
  // `processed` once the server has prepared it as it will be saved; until then (or if it can't), the file as chosen.
  const [chosen, setChosen] = useState<{ url: string; name: string; processed: boolean; dark: boolean } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const previewRequest = useRef(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (chosen?.url.startsWith("blob:")) URL.revokeObjectURL(chosen.url); }, [chosen]);

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const request = ++previewRequest.current;
    setFileError(null);
    setPreparing(false);
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
    setChosen({ url: URL.createObjectURL(file), name: file.name, processed: false, dark: false });
    // Then the same processing a save does, so trimmed edges show before saving. A newer choice wins.
    const form = new FormData();
    form.set("logo", file);
    setPreparing(true);
    preview(form)
      .catch((): LogoPreview => ({ ok: false }))
      .then((result) => {
        if (request !== previewRequest.current) return;
        setPreparing(false);
        if (result.ok) setChosen((current) => (current && current.name === file.name ? { ...current, url: result.url, processed: true, dark: result.needsDarkBackground } : current));
      });
  }

  const typed = normalizeHex(color);
  const theme = brandTheme(typed ?? DEFAULT_BRAND_COLOR);
  const previewLogo: Logo = remove ? null : chosen ? { url: chosen.url, needsDarkBackground: chosen.dark } : currentLogo;
  const sizedLogo = previewLogo ? { ...previewLogo, sizePercent: size } : null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <section aria-label="Logo size preview" className="grid min-w-0 gap-3 xl:col-span-2" data-testid="logo-size-preview">
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">Your workspace header</p>
          {/* The real header's height, columns and logo limits, so what's shown here is what you get. */}
          <div className="grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl border bg-background px-2 lg:px-5" data-testid="header-preview">
            <div className="flex min-w-0 items-center gap-1">
              <Menu aria-hidden className="size-5 shrink-0 text-muted-foreground lg:hidden" />
              {/* eslint-disable-next-line @next/next/no-img-element -- small static PNG, as in the real header */}
              <img src="/brand/flux-wordmark-black.png" alt="" width={452} height={160} className="h-5 w-auto lg:h-[1.625rem]" />
            </div>
            <div className="flex min-w-0 max-w-[calc(100vw-15rem)] justify-center sm:max-w-[calc(100vw-20rem)] lg:max-w-80">
              <BrandLogo
                logo={sizedLogo}
                name={displayName}
                className={`${STAFF_HEADER_LOGO_HEIGHT} max-w-[calc(100vw-16rem)] sm:max-w-[calc(100vw-20rem)] lg:max-w-72`}
                fallbackClassName="block truncate text-sm font-semibold"
              />
            </div>
            <CircleUserRound aria-hidden className="size-6 justify-self-end text-muted-foreground" strokeWidth={1.6} />
          </div>
        </div>
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">Your client pages</p>
          <div className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-background px-4 py-2" data-testid="client-preview">
            <span className="flex min-h-8 min-w-0 items-center text-sm">
              <BrandLogo logo={sizedLogo} name={displayName} className={CLIENT_PAGE_LOGO} fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">Booked</span>
          </div>
        </div>
      </section>

      <ActionForm
        action={action}
        version={version}
        submitLabel="Save changes"
        trackUnsaved
        pendingLabel={chosen ? "Uploading and saving…" : "Saving…"}
        className="max-w-xl min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-6"
        onSuccess={() => {
          // The saved logo now comes from the server; clear the local file.
          setChosen(null);
          setRemove(false);
          if (fileInput.current) fileInput.current.value = "";
        }}
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <Field className="grid-cols-[minmax(0,1fr)]" label="Logo" htmlFor="logo" hint="PNG, JPEG or WebP, up to 4 MB and 8000 pixels a side. Empty transparent edges are trimmed when you save; it is never stretched, and nothing visible is cropped.">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted p-2" data-testid="logo-current">
                <BrandLogo logo={previewLogo} name={displayName} className="max-h-11 max-w-24" fallbackClassName="line-clamp-2 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]" />
              </div>
              <Input ref={fileInput} id="logo" name="logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} className="w-full min-w-0 flex-1 basis-52" />
            </div>
          </Field>
          {fileError ? <p role="alert" className="text-sm text-destructive">{fileError}</p> : null}
          <p aria-live="polite" className="text-xs text-muted-foreground empty:hidden" data-testid="logo-preview-state">
            {preparing ? "Preparing the preview…" : chosen?.processed ? "The preview shows the logo as it will be saved." : ""}
          </p>
          {currentLogo && !chosen ? (
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
              <input type="checkbox" name="remove_logo" checked={remove} onChange={(e) => setRemove(e.target.checked)} className="size-4 accent-primary" />
              Remove the logo (show the business name instead)
            </label>
          ) : null}
          {previewLogo ? (
            <div className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3 sm:max-w-xs">
                <Label htmlFor="logo_size_percent">Logo size</Label>
                <output htmlFor="logo_size_percent" className="text-sm tabular-nums text-muted-foreground" data-testid="logo-size-value">{logoSizeLabel(size)}</output>
              </div>
              <input
                id="logo_size_percent"
                name="logo_size_percent"
                type="range"
                min={LOGO_SIZE.min}
                max={LOGO_SIZE.max}
                step={LOGO_SIZE.step}
                value={size}
                aria-valuetext={logoSizeLabel(size)}
                onChange={(e) => setSize(Number(e.target.value))}
                className="h-11 w-full cursor-pointer accent-primary sm:max-w-xs md:h-6"
              />
              <p className="text-xs text-muted-foreground">
                Mostly helps square logos, which are limited by height. Applies to your workspace header and client pages; proposals and emails keep a standard size.
              </p>
            </div>
          ) : (
            <input type="hidden" name="logo_size_percent" value={size} />
          )}
        </div>

        <div className="grid gap-3 border-t pt-6">
          <Field label="Primary colour" htmlFor="primary_color" hint="Used for buttons and accents on your client pages. Leave empty for the default dark grey.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Pick the primary colour"
                value={typed ?? DEFAULT_BRAND_COLOR}
                onChange={(e) => setColor(e.target.value)}
                className="h-11 w-14 cursor-pointer rounded-lg border bg-transparent p-1 md:h-8 md:w-12"
              />
              <Input id="primary_color" name="primary_color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#111827" maxLength={7} className="w-32 font-mono" />
            </div>
          </Field>
          {color !== "" && !typed ? <p role="alert" className="text-sm text-destructive">Enter the colour as a hex value like #1a2b3c.</p> : null}
          <p className="text-xs text-muted-foreground" data-testid="contrast-note">
            Button text on this colour: {theme.foreground === "#ffffff" ? "white" : "dark"} (contrast {theme.foregroundContrast.toFixed(1)}:1).
            {theme.contrastOnWhite < 3 ? " This colour is light, so accents on white pages will be subtle." : ""}
          </p>
        </div>
      </ActionForm>

      <section aria-label="Client page preview" className="grid max-w-xl content-start gap-3 rounded-xl bg-muted p-4 xl:sticky xl:top-20 xl:self-start" data-testid="branding-preview">
        <p className="text-xs text-muted-foreground">Preview · not saved, nothing is sent</p>
        <div className="grid gap-4 overflow-hidden rounded-xl bg-background pb-4 text-sm shadow-xs">
          <header className="grid gap-2 p-4" style={{ background: theme.color, color: theme.foreground }}>
            <div className="flex min-h-10 items-center">
              <BrandLogo logo={previewLogo} name={displayName} className="max-h-12 max-w-48" fallbackClassName="text-xs font-medium opacity-90" />
            </div>
            <p className="text-lg font-semibold">Alex &amp; Sam Wedding</p>
            <p className="opacity-90">Saturday, June 12, 2027 · Sample venue</p>
          </header>
          <div className="mx-4 grid gap-2 rounded-xl border-2 p-3" style={{ borderColor: theme.color }}>
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
