"use client";

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { Check, ChevronDown, CircleUserRound, Menu } from "lucide-react";
import { ActionForm } from "@/components/app/action-form";
import { BrandLogo } from "@/components/app/brand-logo";
import { EventStatusPill } from "@/components/app/client-event-ui";
import { Field } from "@/components/app/fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandGradientCss, brandProps, brandTheme, DEFAULT_BRAND_COLOR, GRADIENT_ON, normalizeHex, suggestLooks } from "@/lib/branding/colors";
import { CLIENT_PAGE_LOGO, LOGO_SIZE, logoSizeLabel, STAFF_HEADER_LOGO } from "@/lib/branding/logo-size";
import { cn } from "@/lib/utils";
import type { ActionState } from "@/lib/forms";
import type { LogoPreview } from "./actions";

type Logo = { url: string; needsDarkBackground: boolean } | null;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Owner branding in three parts: the logo, the colours, and one live preview.
 * The preview shows the chosen file from this device before anything is
 * uploaded; on save the server verifies and re-encodes it. Nothing here sends
 * email or touches client records.
 *
 * Colours: a primary colour, then a look. "Solid" is the primary colour on its
 * own, as every business had before gradients. The other looks are gradients
 * Flux suggests for that primary colour (suggestLooks); each is only an accent
 * colour, so choosing one saves an ordinary accent and the gradient preference.
 * An accent of the owner's own (typed under "Custom accent colour", or saved
 * before) is the "Custom" look. Less-used settings sit in disclosures.
 *
 * The preview renders through the same brand variables, utilities and BrandLogo
 * as the client pages, so it shows what clients see today, logo backdrop included.
 */

/** Which look is chosen: solid, the owner's own accent, or a suggested look's key. */
type Look = "solid" | "custom" | (string & {});
export function BrandingForm({
  action,
  preview,
  version,
  displayName,
  currentLogo,
  currentColor,
  currentAccent,
  currentGradient,
  currentSize,
}: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  /** Runs the save's own image processing without storing anything, so the preview shows the logo as it will be saved. */
  preview: (form: FormData) => Promise<LogoPreview>;
  version: number;
  displayName: string;
  currentLogo: Logo;
  currentColor: string | null;
  /** A stored accent: the gradient's, or one kept from earlier. */
  currentAccent: string | null;
  currentGradient: boolean;
  currentSize: number;
}) {
  const [color, setColor] = useState(currentColor ?? "");
  // The owner's own accent: typed here, or saved earlier (a suggested look that was saved shows as that look instead).
  const [custom, setCustom] = useState(currentAccent ?? "");
  const [look, setLook] = useState<Look>(() =>
    currentGradient ? (suggestLooks(currentColor).find((l) => l.accent === currentAccent)?.key ?? "custom") : "solid",
  );
  const [view, setView] = useState<"proposal" | "event">("proposal");
  const [sizeView, setSizeView] = useState<"workspace" | "client">("workspace");
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
  const primary = typed ?? DEFAULT_BRAND_COLOR;
  const looks = suggestLooks(primary);
  const customAccent = normalizeHex(custom);
  // A suggested look follows the primary colour; if it no longer exists for the new colour, the first one stands in.
  const suggested = look === "solid" || look === "custom" ? null : (looks.find((l) => l.key === look) ?? looks[0] ?? null);
  const selected: Look = look === "solid" || look === "custom" ? look : (suggested?.key ?? "solid");
  const accent = selected === "custom" ? customAccent : (suggested?.accent ?? null);
  const gradient = selected !== "solid";
  // The owner's accent is offered as a look of its own unless a suggestion is the very same colour.
  const showCustom = selected === "custom" || (customAccent !== null && !looks.some((l) => l.accent === customAccent));
  const brandColors = gradient && accent ? { primary, accent, gradient: GRADIENT_ON } : { primary };
  const theme = brandTheme(brandColors);
  const solid = brandTheme(primary);
  const deepened = solid.fill !== solid.color || (theme.gradient !== null && theme.gradient.to !== accent);
  const previewLogo: Logo = remove ? null : chosen ? { url: chosen.url, needsDarkBackground: chosen.dark } : currentLogo;
  const sizedLogo = previewLogo ? { ...previewLogo, sizePercent: size } : null;
  const swatchOf = (accentColor: string): CSSProperties => ({ background: brandGradientCss(brandTheme({ primary, accent: accentColor, gradient: GRADIENT_ON })), color: "#ffffff" });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <ActionForm
        action={action}
        version={version}
        submitLabel="Save changes"
        trackUnsaved
        pendingLabel={chosen ? "Uploading and saving…" : "Saving…"}
        className="max-w-xl min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-8"
        onSuccess={() => {
          // The saved logo now comes from the server; clear the local file.
          setChosen(null);
          setRemove(false);
          if (fileInput.current) fileInput.current.value = "";
        }}
      >
        <section aria-labelledby="logo-heading" className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <h2 id="logo-heading" className="text-base font-semibold">Business logo</h2>
          <Field className="grid-cols-[minmax(0,1fr)]" label="Logo" htmlFor="logo" hint="PNG, JPEG or WebP, up to 4 MB. Without a logo, your business name is shown.">
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
            <label className="flex min-h-11 w-fit items-center gap-2 text-sm md:min-h-0">
              <input type="checkbox" name="remove_logo" checked={remove} onChange={(e) => setRemove(e.target.checked)} className="size-4 accent-primary" />
              Remove the logo
            </label>
          ) : null}
          {previewLogo ? (
            <Advanced summary="Logo size" open={currentSize !== LOGO_SIZE.default} value={<output htmlFor="logo_size_percent" data-testid="logo-size-value">{logoSizeLabel(size)}</output>} testId="logo-size-options">
              <div className="grid gap-1.5">
                <Label htmlFor="logo_size_percent" className="sr-only">Logo size</Label>
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
                  Mostly helps square logos. Applies to your workspace header and client pages; proposals and emails keep a standard size.
                </p>
                {/* Where the size shows, at its real size: the header's own height, columns and logo limits (STAFF_HEADER_LOGO),
                    or a client page's header. Out of the disclosure's indent, so it has the form's full width. */}
                <div className="-ml-5.5 grid gap-2 pt-1.5" data-testid="logo-size-preview">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className="text-xs text-muted-foreground">Shown at its real size. Saved with Save changes.</p>
                    <div role="group" aria-label="Show the logo in" className="inline-flex rounded-lg bg-muted p-0.5 text-xs">
                      {([["workspace", "Workspace header"], ["client", "Client pages"]] as const).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={sizeView === key}
                          onClick={() => setSizeView(key)}
                          className={cn(
                            "min-h-11 rounded-md px-2.5 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-7",
                            sizeView === key ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {sizeView === "workspace" ? (
                    <div className="grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 overflow-hidden rounded-xl border bg-background px-2 lg:px-5" data-testid="header-preview">
                      <div className="flex min-w-0 items-center gap-1">
                        <Menu aria-hidden className="size-5 shrink-0 text-muted-foreground lg:hidden" />
                        {/* eslint-disable-next-line @next/next/no-img-element -- small static PNG, as in the real header */}
                        <img src="/brand/flux-wordmark-black.png" alt="" width={452} height={160} className="h-5 w-auto lg:h-[1.625rem]" />
                      </div>
                      <div className="flex min-w-0 items-center justify-center">
                        <BrandLogo logo={sizedLogo} name={displayName} className={STAFF_HEADER_LOGO} fallbackClassName="block truncate text-sm font-semibold" />
                      </div>
                      <CircleUserRound aria-hidden className="size-6 justify-self-end text-muted-foreground" strokeWidth={1.6} />
                    </div>
                  ) : (
                    <div className="flex min-h-14 items-center justify-between gap-3 overflow-hidden rounded-xl border bg-plan-canvas px-4 py-2" data-testid="client-header-preview">
                      <span className="flex min-h-8 min-w-0 items-center text-sm">
                        <BrandLogo logo={sizedLogo} name={displayName} className={CLIENT_PAGE_LOGO} fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
                      </span>
                      <EventStatusPill label="Booked" tone="done" />
                    </div>
                  )}
                </div>
              </div>
            </Advanced>
          ) : (
            <input type="hidden" name="logo_size_percent" value={size} />
          )}
        </section>

        <section aria-labelledby="colours-heading" className="grid grid-cols-[minmax(0,1fr)] gap-5 border-t pt-8">
          <h2 id="colours-heading" className="text-base font-semibold">Brand colours</h2>
          <div className="grid gap-3">
            <Field label="Primary colour" htmlFor="primary_color" hint="Leave empty for the default dark grey.">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the primary colour"
                  value={primary}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-11 w-14 cursor-pointer rounded-lg border bg-transparent p-1 md:h-8 md:w-12"
                />
                <Input id="primary_color" name="primary_color" value={color} onChange={(e) => setColor(e.target.value)} placeholder="#111827" maxLength={7} className="w-32 font-mono" />
              </div>
            </Field>
            {color !== "" && !typed ? <p role="alert" className="text-sm text-destructive">Enter the colour as a hex value like #1a2b3c.</p> : null}
          </div>

          <div className="grid gap-3">
            <div className="grid gap-0.5">
              <p id="look-label" className="text-sm font-medium">Look</p>
              <p className="text-xs text-muted-foreground">Keep your colour solid, or choose a gradient that suits it.</p>
            </div>
            <div role="radiogroup" aria-labelledby="look-label" className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3" data-testid="brand-looks">
              <LookChoice value="solid" label="Solid" checked={selected === "solid"} onChange={() => setLook("solid")} swatch={{ background: solid.color, color: solid.foreground }} />
              {looks.map((l) => (
                <LookChoice key={l.key} value={l.key} label={l.label} checked={selected === l.key} onChange={() => setLook(l.key)} swatch={swatchOf(l.accent)} />
              ))}
              {showCustom ? (
                <LookChoice value="custom" label="Custom" checked={selected === "custom"} onChange={() => setLook("custom")} swatch={customAccent ? swatchOf(customAccent) : null} />
              ) : null}
            </div>
            <input type="hidden" name="brand_style" value={gradient ? "gradient" : "solid"} />
            {gradient ? <input type="hidden" name="accent_color" value={accent ?? custom} /> : null}
            {deepened ? (
              <p className="text-xs text-muted-foreground" data-testid="contrast-note">Light colours are deepened where text sits on them, so it stays readable.</p>
            ) : null}
          </div>

          <Advanced summary="Custom accent colour" open={selected === "custom"} testId="custom-accent">
            <div className="grid gap-3">
              <Field label="Accent colour" htmlFor="custom_accent" hint="The colour your gradient blends into. Choosing one selects the Custom look.">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick the accent colour"
                    value={customAccent ?? accent ?? looks[0]?.accent ?? primary}
                    onChange={(e) => {
                      setCustom(e.target.value);
                      setLook("custom");
                    }}
                    className="h-11 w-14 cursor-pointer rounded-lg border bg-transparent p-1 md:h-8 md:w-12"
                  />
                  <Input
                    id="custom_accent"
                    value={custom}
                    onChange={(e) => {
                      setCustom(e.target.value);
                      setLook("custom");
                    }}
                    placeholder={looks[0]?.accent ?? "#1a2b3c"}
                    maxLength={7}
                    className="w-32 font-mono"
                  />
                </div>
              </Field>
              {selected === "custom" && !customAccent ? <p role="alert" className="text-sm text-destructive">Enter the accent colour as a hex value like #1a2b3c.</p> : null}
            </div>
          </Advanced>
        </section>
      </ActionForm>

      <section aria-labelledby="preview-heading" className="grid max-w-xl content-start gap-3 xl:sticky xl:top-20 xl:self-start" data-testid="branding-preview" data-style={gradient && accent ? "gradient" : "solid"}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="grid gap-0.5">
            <h2 id="preview-heading" className="text-base font-semibold">Preview</h2>
            <p className="text-xs text-muted-foreground">What clients see. Nothing is saved or sent.</p>
          </div>
          <div role="tablist" aria-label="Preview of" className="inline-flex rounded-lg bg-muted p-0.5 text-sm">
            {([["proposal", "Proposal"], ["event", "Event page"]] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`preview-tab-${key}`}
                aria-selected={view === key}
                aria-controls="preview-panel"
                onClick={() => setView(key)}
                className={cn(
                  "min-h-11 rounded-md px-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-8",
                  view === key ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* The page's own brand variables and marker, exactly as a client page sets them (brandProps). */}
        <div id="preview-panel" role="tabpanel" aria-labelledby={`preview-tab-${view}`} {...brandProps(brandColors)} className="rounded-xl bg-muted p-3 sm:p-4">
          {view === "proposal" ? (
            <div className="grid gap-4 overflow-hidden rounded-xl bg-background pb-4 text-sm shadow-xs" data-testid="proposal-preview">
              <header className="grid gap-2 bg-brand-hero p-4 brand-gradient:**:opacity-100" data-testid="preview-hero">
                <div className="flex min-h-10 items-center">
                  <BrandLogo onHero logo={previewLogo} name={displayName} className="max-h-12 max-w-48" fallbackClassName="text-sm font-semibold tracking-wide uppercase opacity-90" />
                </div>
                <p className="text-lg font-semibold">Alex &amp; Sam Wedding</p>
                <p className="opacity-90">Saturday, June 12, 2027 · Sample venue</p>
              </header>
              <div className="mx-4 grid gap-2 rounded-xl border-2 border-brand-ink p-3">
                <p className="font-medium">Signature package</p>
                <p className="text-muted-foreground">Sound, lighting and an MC for your whole evening.</p>
                <span className="inline-flex w-fit rounded-lg bg-brand px-3 py-2 font-medium text-brand-foreground">Submit my selection</span>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 rounded-xl bg-plan-canvas p-4 text-sm" data-testid="client-preview">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-h-8 min-w-0 items-center text-sm">
                  <BrandLogo logo={sizedLogo} name={displayName} className={CLIENT_PAGE_LOGO} fallbackClassName="font-semibold [overflow-wrap:anywhere]" />
                </span>
                <EventStatusPill label="Booked" tone="done" />
              </div>
              <div className="grid gap-1">
                <p className="text-lg leading-snug font-semibold">Alex &amp; Sam Wedding</p>
                <p className="text-plan-ink-2">Saturday, June 12, 2027 · Sample venue</p>
              </div>
              <div className="grid gap-3 rounded-xl bg-brand-wash p-4" data-testid="preview-wash">
                <div className="grid gap-1">
                  <p className="font-semibold">Plan your event</p>
                  <p className="tabular-nums">
                    <span className="font-semibold">60% complete</span>
                    <span className="text-plan-ink-2"> · 12 of 20 required answers</span>
                  </p>
                </div>
                <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-plan-surface">
                  <div className="h-full w-3/5 rounded-full bg-brand-gradient" data-testid="preview-progress" />
                </div>
                <span className="inline-flex w-fit rounded-[10px] bg-brand-ink px-4 py-2.5 font-semibold text-white">Open planning</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

/** One look: a swatch of the real result with its text colour, and the choice itself. The whole tile is the target. */
function LookChoice({ value, label, checked, onChange, swatch }: { value: string; label: string; checked: boolean; onChange: () => void; /** Null: an accent that isn't a colour yet. */ swatch: CSSProperties | null }) {
  return (
    <label className="group/look grid cursor-pointer gap-1.5 text-sm" data-testid={`look-${value}`}>
      <span
        aria-hidden
        style={swatch ?? undefined}
        className={cn(
          "relative flex h-14 items-end rounded-lg px-2.5 pb-1.5 text-sm font-semibold ring-offset-2 ring-offset-background transition-shadow motion-reduce:transition-none",
          "group-has-[:checked]/look:ring-2 group-has-[:checked]/look:ring-foreground group-has-[:focus-visible]/look:ring-3 group-has-[:focus-visible]/look:ring-ring",
          swatch ? null : "border border-dashed text-muted-foreground",
        )}
      >
        Aa
        {checked ? (
          <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-background text-foreground shadow-xs">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5">
        <input type="radio" name="look" value={value} checked={checked} onChange={onChange} className="sr-only" />
        <span className={checked ? "font-semibold" : "text-muted-foreground group-hover/look:text-foreground"}>{label}</span>
      </span>
    </label>
  );
}

/** A less-used setting, folded away: its name, its current value if it has one, and the control inside. */
function Advanced({ summary, value, open, testId, children }: { summary: string; value?: React.ReactNode; open?: boolean; testId: string; children: React.ReactNode }) {
  return (
    <details open={open} className="group/advanced" data-testid={testId}>
      <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-4 -rotate-90 transition-transform group-open/advanced:rotate-0 motion-reduce:transition-none" />
        {summary}
        {value ? <span className="font-normal tabular-nums">· {value}</span> : null}
      </summary>
      <div className="pt-2 pl-5.5">{children}</div>
    </details>
  );
}
