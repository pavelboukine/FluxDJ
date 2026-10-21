---
name: Flux DJ
description: DJ business management and client event planning. Neutral, calm interface; each DJ business's brand colour is the client-facing accent.
colors:
  # CURRENT tokens (src/app/globals.css, shadcn defaults), recorded as implemented.
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  shell: "oklch(0.967 0.002 264)"
  brand-default: "#111827"
typography:
  # Client planning header and section titles: implemented in 6C.2 (phone 1.375rem, desktop 1.75rem / 1.375rem).
  event-title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  page-title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.025em"
  # Question rows (6C.3a): 15px medium title over a 14px preview.
  question-title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.375
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  hint:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
  eyebrow:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.025em"
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  2xl: "18px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
components:
  button-brand:
    backgroundColor: "{colors.brand-default}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.xl}"
    height: "44px"
    padding: "0 16px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "0 10px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    height: "32px"
    padding: "4px 10px"
  section-surface:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.2xl}"
    padding: "16px"
  question-card:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.xl}"
    padding: "10px 16px"
  status-badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "9999px"
    height: "20px"
    padding: "2px 8px"
---

<!--
Status: written 2026-10-19 during Batch 6C.1 (audit). Batch 6C.2 (2026-10-19) implemented
the client planning header, overview, navigation, status glyphs, Brand Ink/Tint and the
planning tokens (src/app/globals.css, [data-plan-shell]). Batch 6C.3a (2026-10-20, local)
implemented question rows (PlanMoment), live answer previews (src/lib/planning/summaries.ts,
answer-preview.tsx), the one-line "Still needed" block and row-level save state. Batch 6C.3b
(2026-10-20, local) implemented the editor internals: planning-scoped fields (globals.css,
[data-plan-shell]: 44px/16px on phones, Brand Ink focus), labels with a muted "Optional" tag
(label-text.tsx; accessible names unchanged), one choice pattern (choice-list.tsx, refined in
6C.3c: rounded rows on spacing with no separators, grey hover, a 10% Brand Ink wash when chosen,
"discuss" options last in the list), one list pattern (item-list.tsx: rows on
hairlines, reorder arrows + Edit, Remove inside the edit panel, "+ Add …" disclosures) and a
read-only review mode ([data-plan-readonly]). Batch 6C.4 (2026-10-20) finished client planning:
the review hides editing guidance ([data-plan-help], field hints) and shows chosen options as
plain text; "Not sure yet" options use full-contrast text (only unavailable options are grey);
client deadlines read "through Friday, July 30" for a midnight cutoff, never a zone identifier
(clientDeadlinePhrase); a complete, fully saved plan shows "You're all caught up!" on the
overview; "All changes saved" shows only where something was changed; a row's Retry shows only
while the row is closed. The "Current implementation" notes below describe the pre-6C state.
The frontmatter records the CURRENT implementation so tools read real values.
Each section below separates "Current implementation" from "Proposed direction".
The proposed direction is NOT implemented and is pending approval. Once approved,
it governs new client-planning work; re-run /impeccable document after 6C.2/6C.3
ship so the frontmatter reflects the new tokens.
Scope of the proposal: client planning. The staff shell, proposals, contracts,
payments, settings and emails will follow later and are not specified here.

Confirmed decisions (2026-10-19):
- Colour: neutral UI; the business's brand colour is the only client-page accent.
- Answer summaries come from live editor state (read-only, published like the
  save registry), never by changing autosave.
- Phone navigation: sticky slim section bar (opens a full-height sheet) plus a
  sticky bottom Previous/Next bar.
- "Not sure yet? Discuss with your DJ" is a separated, quieter option; same
  answer value and progress meaning.
- Required/optional: drop the visible "(needed)", show a muted "Optional" tag,
  and keep today's accessible names (tests and screen readers unchanged).
-->

# Design System: Flux DJ

## Overview

**Creative North Star (proposed): "The Shared Run of Show"**

Client planning should feel like a calm, well-kept notebook that the client and their DJ share. It fills up as decisions are made and ends as the plan the DJ performs from. It is an event workspace, not a survey. Answers stay visible once given, structure follows the real order of the event, and the DJ business's identity sits quietly on the door.

### Current implementation

The interface is unmodified shadcn/ui (base-ui primitives, "new-york" defaults) on Geist, in a neutral grey scale with near-black as the primary. Client pages add one tenant variable, `--brand`, used for a 6px header band, the primary planning button and the progress bar fill.

Hierarchy is carried almost entirely by bordered, rounded, lightly shadowed white containers on a pale grey canvas (`bg-muted/40`). These containers nest up to five levels deep (page header card, section card, question card, song or playlist row, "Add a song" disclosure). Text is mostly 14px with 12px muted hints. Status is shown by lucide circle icons, outline pill badges and coloured text, often all three at once.

It is functional, accessible in most respects and consistent in its generic way. It reads as a form builder, not as a product with its own point of view.

### Proposed direction: Premium and Welcoming

Neutral, quiet surfaces; one accent (the business's brand colour); type and spacing do the hierarchy work that borders do today. Density is moderate: a phone shows one decision at a time without scrolling past chrome. Motion is limited to state feedback (a disclosure opening, a save confirming).

**Key Characteristics:**
- One elevated surface per level. Rows inside a surface are separated by hairlines and spacing, not by more cards.
- Answers are visible when collapsed: every question row summarises what was entered.
- Status indicators can never be mistaken for inputs.
- The business's brand colour is the only accent, always used through contrast-safe derived tokens.
- Works for weddings, corporate events, school events and parties: no wedding motifs, no decorative imagery.

## Colors

### Current implementation

- **Neutrals:** shadcn achromatic defaults: background white, foreground `oklch(0.145 0 0)`, muted `oklch(0.97 0 0)`, muted-foreground `oklch(0.556 0 0)` (#737373), border `oklch(0.922 0 0)`. The page canvas is `bg-muted/40`.
- **Primary:** `oklch(0.205 0 0)` near-black. Used by default buttons (Add song, Add playlist), native radio and checkbox accents (`accent-primary`) and ring colours. It is not the tenant colour, so a business with a lavender brand still gets black controls.
- **Tenant brand:** `--brand` and `--brand-foreground` from `brandStyle()` in `src/lib/branding/colors.ts` (default #111827; foreground is white or black, whichever passes 4.5:1). It is used as a solid fill only. There is no tint or legible-on-white variant, so pale brands (BOUPROD's #cbc7ff) produce a progress fill that barely separates from its grey track.
- **Status (hard-coded Tailwind colours, not tokens):** emerald for complete and "Planning open", amber for in-progress icons, "Not answered yet" text, timing warnings and the read-only notice, and `destructive` red for save errors and validation.
- **There is no "Flux blue"** anywhere in the code or brand assets. The Flux mark is black and white.

### Proposed direction

The palette is neutral with a single tenant accent. Everything else is semantic.

#### Primary (per business)
- **Brand Solid** (`--brand`, unchanged): primary planning actions only (Continue planning, Add song), with `--brand-foreground` text.
- **Brand Ink** (new, derived): the brand colour darkened in OKLCH until it reaches at least 3:1 on white (4.5:1 when used for text). Used for thin indicators: progress fill, progress rings, the current-section marker, selected-option borders and focus rings. For #cbc7ff this lands near a mid violet; for #111827 it equals the brand.
- **Brand Tint** (new, derived): about 6-8% brand mixed into white. Used for the selected-option background, the current nav row and the open-question background.

#### Neutral
- **Canvas:** a very slightly cool off-white (around `oklch(0.975 0.003 264)`, near today's `--shell`) behind white surfaces, so sheets separate without shadows.
- **Ink:** the foreground, near-black with a hint of cool hue, for titles and answers.
- **Secondary Ink:** for hints and meta. It must reach 4.5:1 on canvas and on every tint it sits on (today's #737373 fails at 4.2:1 on the amber notice).
- **Hairline:** today's border value, used for row separators and input outlines. Containers lose most of their borders.

#### Semantic (tokens, not raw Tailwind colours)
- **Done:** a single green, used for the completed check only.
- **Attention:** amber, reserved for things the client must act on: timing conflicts and "to discuss" items. Not for "not answered yet", which is normal and neutral.
- **Error:** red, only for failed saves and invalid input.

#### Named Rules
**The One Accent Rule.** On client pages the only chromatic colour besides semantic status is the business's brand colour, always used through Solid, Ink or Tint. No platform blue, no gradients.

**The Calm Gap Rule.** An unanswered question is not an error. It uses neutral text and never amber or red.

## Typography

### Current implementation

Geist Sans throughout (via `next/font`), Geist Mono loaded but unused in planning. Sizes observed: page and section titles `text-xl sm:text-2xl` semibold with tight tracking; panel subheadings `text-base` semibold; question titles `text-sm` semibold; body, labels and inputs `text-sm` (inputs `text-base` below `md`, which avoids iOS zoom); hints and meta `text-xs` muted. Small uppercase tracked eyebrows ("EVENT PLANNING", "PART 6 OF 7 OF YOUR EVENT", "EVENT DETAILS", "YOUR EVENT, IN ORDER") label nearly every block. Labels use `leading-none`, so two-line labels collide. Required and optional state is a parenthetical in every label ("(needed)", "(optional)").

### Proposed direction

**Font:** keep Geist. It is neutral, legible, already loaded and not wedding-coded. Distinction comes from the scale, weight contrast and spacing, not from a novelty face. No serif.

**Character:** confident sans titles over quiet body text; answers read in full ink, questions in slightly lighter weight, so the client's own content is the most prominent text on the page.

#### Hierarchy (proposed values, mobile then desktop)
- **Event title** (600, 22px then 26px, 1.2, -0.02em): the event name in the workspace header. Once per page.
- **Section title** (600, 20px then 22px, 1.25): the open section.
- **Question title** (500, 15px then 16px, 1.35): each question row, one step larger than today so it reads as a title, not a label.
- **Answer summary** (400, 14px, 1.45, ink): what the client entered, shown on collapsed rows.
- **Label** (500, 14px, 1.35): field labels. Never `leading-none`.
- **Hint and meta** (400, 13px, 1.4, secondary ink): help text, counts, statuses.
- **Numbers:** tabular figures for progress counts and times.

#### Named Rules
**The One Eyebrow Rule.** At most one small uppercase label per screen (the stage position, e.g. "Part 3 of 7"). Group headings in navigation use sentence case.

**The Mark the Minority Rule.** Mark optional fields with a muted "Optional" tag after the label. Show "Needed" only in summaries and checklists, not in every label.

## Layout

### Current implementation

Centred column `max-w-5xl` with `px-4`. Desktop (≥1024px) uses a `16rem` sidebar beside the section; below 1024px a `<details>` "All sections" picker replaces it. Stacked above the workspace: the header card, a full-width deadline card and (on mobile) the picker. That is about 540px of chrome on a 390px phone before any question is visible. Sections are a single `grid gap-5` column of fields. Editors use `sm:grid-cols-2` for pairs (title and artist, times). Previous and Next sit at the end of each section. Nothing is sticky. Every section stays mounted and hidden, and only the `?section=` view is shown.

### Proposed direction

- **Compact workspace header:** brand logo, event title, date and venue, and the editing state in one block. The deadline becomes one line inside it ("Open for changes until Sat, Jul 31"). The separate deadline card goes. Target height on a phone is 160px or less.
- **Desktop:** on a section, an unboxed sticky navigation column on the canvas (no card) beside the section sheet. On the client's overview there is no sidebar: progress and attention sit beside "Event details" and "Your event, in order", whose rows lead to every section (implemented in 6C.2; the staff page keeps its sidebar everywhere).
- **Phone:** a sticky slim section bar under the header (current section, its progress ring, "All sections"). The section list opens as a full-height sheet instead of pushing content down. A sticky bottom bar carries Previous and Next within thumb reach, padded for the safe area. It never covers the focused field.
- **Rhythm:** 4px base. 24px between question rows' content blocks, 20px between fields, 6px from label to control, 32px between section-level groups. Content width inside a question on a 390px phone should be at least 340px (today 264px), achieved by removing nested padding.
- **Reading width:** hints and descriptions are capped near 65ch.

## Elevation & Depth

### Current implementation

Hybrid. White cards with a 1px border and `shadow-sm` on a pale grey canvas, repeated at each nesting level (the detector found 6 card-in-card instances in the Party section alone). Question cards have borders but no shadow. The playlist form uses a dashed border.

### Proposed direction

Flat by default, with tonal layering. White sheets on the off-white canvas carry depth. Shadows are reserved for floating layers only: the mobile section sheet, sticky bars once content scrolls under them, and menus.

**The One Sheet Rule.** A section is one sheet. Questions are rows inside it, separated by hairlines. An open question is shown by a brand-tint background and expanded content, not by a new bordered box. Nothing inside a question gets its own card.

## Shapes

### Current implementation

`--radius` 10px with derived steps. Sheets use 18px (`rounded-2xl`), question cards 14px (`rounded-xl`), inputs, buttons and rows 10px (`rounded-lg`), badges full pills, and primary planning buttons 14px. Native browser radios, checkboxes, time inputs and selects keep their platform shapes. Native `<details>` triangles ("▶ Add a song") sit next to lucide chevrons.

### Proposed direction

A documented two-step scale. Sheets and sheet-like layers use 16px. Interactive controls (inputs, buttons, option rows, segmented controls) use 10px. Pills are only for counts and status in navigation, not for every status. Every disclosure uses the same chevron.

## Components

### Current implementation (client planning)

| Pattern | Where | Notes |
|---|---|---|
| Header card | `src/app/[tenant]/planning/[eventId]/page.tsx` | Brand band, logo, `EditingChip`, title, date and venue, disclaimer line |
| `EditingNotice` | `src/components/planning/progress.tsx` | Separate card with the deadline sentence; amber when closed |
| `PlanSidebar`, `SectionPicker`, `SectionNavItem`, `OverviewNavItem` | `src/components/planning/plan-navigation.tsx` | Lucide `Circle`, `CircleDot`, `CircleCheck` and `CircleMinus` as status, plus a status text line |
| `PlanOverview` | `src/components/planning/client-planning.tsx` | Progress card plus a "Still to sort out" list that repeats the section list |
| `ProgressMeter` | `progress.tsx` | Percentage, headline and an 8px bar; good ARIA |
| `SectionHeader` | `plan-navigation.tsx` | Eyebrow, title and status line with icon and flags |
| `PlanMoment` | `plan-navigation.tsx` | `<details>` question card: `h3` title in the summary, outline `Badge` status, chevron. No answer summary |
| `ItemChecklist` | `progress.tsx` | "0 of N needed answers" plus a row per requirement in amber, at the top of every editor |
| `ItemStatus` | `progress.tsx` | Outline or secondary `Badge` ("Not started", "In progress", "Complete") |
| `FieldBox` | `src/components/planning/basics-editor.tsx` | Label, control, error and hint. The shared field wrapper |
| `SongFields` | `src/components/planning/song-fields.tsx` | Shared song inputs (6B). Good |
| `ChoiceGroup` (local) and inline radio lists | `participants-editor.tsx`, `music-editor.tsx`, `timed-editors.tsx`, `stage-details-editor.tsx`, `general-editors.tsx` | The same radio pattern in about 5 copies, with different spacing |
| `EntryList` | `participants-editor.tsx` | Ordered rows with Move up, Move down, Edit and Remove buttons, plus undo |
| Song and playlist rows | `music-editor.tsx` | Bordered rows with four outline buttons each |
| `SaveStatus` | `src/components/planning/use-autosave.tsx` | Line at the bottom of each editor ("All changes saved", "Retry saving") |
| `Flags` | `plan-navigation.tsx` | "Not saved", "N to discuss" and "Check timing" pills |
| shadcn `Button`, `Input`, `Textarea`, `Badge`, `Label` | `src/components/ui/` | Defaults. `h-8` (32px) controls, `transition-all` |

### Proposed direction

**Status Glyph** (implemented in 6C.2 as `StatusGlyph` / `ProgressGlyph` in `plan-navigation.tsx`; replaces the lucide circles in navigation and headers). Not started: a filled grey disc. In progress: the same disc with its right half filled in Brand Ink, always the same (a state, never a percentage; the words beside it carry the exact count). Complete: a solid green disc with a white check. Not applicable: a grey disc with a dash. No outlined ring and no centre dot, so a status never looks like a radio. Always shown next to its words.

**Question Row** (replaces `PlanMoment` card styling; same `<details>` mechanics, same `data-plan-item` and default-open reset). Shows the title, a one-line answer summary or the state ("Not started", "To discuss with your DJ", "Not happening", "DJ's choice"), a trailing status glyph and a chevron. When open, it gets a Brand Tint background and the editor below without a nested border. The title moves out of a heading-inside-`<summary>`.

**Answer Summary** (new, per editor type). A one-line digest of the item's current answers. See the audit report for per-type rules.

**Choice List** (one shared component replacing the 5 radio copies). Full-width option rows, at least 44px, with the whole row as the hit target. Selected rows get a Brand Ink border and Brand Tint fill. Hints sit under the option label. "Not sure yet? Discuss with your DJ" is visually separated as a secondary option, so the primary choices read first.

**Field** (evolves `FieldBox`). The label with a muted "Optional" tag, the control, then hint then error, at a consistent 6px rhythm. Controls are 44px tall on touch (40px on desktop), and `select` uses 16px text on mobile.

**Item List** (evolves `EntryList`, song and playlist rows). Hairline-separated rows inside the open question. The primary action is Edit; reordering uses compact up and down icon buttons with labels for assistive technology and 44px hit areas; Remove lives inside edit mode, keeping the existing undo. The add form is a clear "Add a song" button that opens inline, and it opens automatically when the list is empty and the client has chosen to list songs.

**Save Indicator** (presentation of `SaveStatus` and the save registry). Quiet "Saved" or "Saving…" in the question row's header area. Failures show "Not saved · Retry" next to the question title, are repeated in the mobile sticky bar, and keep `role="alert"`. The same messages and behaviour as today, placed where the change happened.

**Read View** (for closed planning). Answers render as text using the Answer Summary and detail formatters instead of disabled empty inputs.

## Do's and Don'ts

### Do:
- **Do** use one sheet per section and hairline-separated rows inside it.
- **Do** show what the client entered on every collapsed question.
- **Do** derive every brand usage from `--brand` through Solid, Ink or Tint, and check contrast for pale and dark brand colours (#cbc7ff and #111827 are the test pair).
- **Do** keep touch targets at 44px or more and `select` text at 16px on phones.
- **Do** keep autosave, revision, retry and "not saved elsewhere" behaviour exactly as it is. Change only where and how it is shown.
- **Do** write copy that works for a wedding, a corporate event and a school dance.

### Don't:
- **Don't** nest a bordered or rounded container inside another inside a section. The detector counts these; the target is zero.
- **Don't** use an outline circle, dotted circle or ringed dot as a status indicator anywhere near radio buttons.
- **Don't** colour unanswered questions amber or red.
- **Don't** add an uppercase eyebrow above every block.
- **Don't** introduce gradients, glows, heavy shadows, decorative icons or a platform blue on client pages.
- **Don't** add wedding motifs (rings, florals, script fonts) to shared planning UI.
- **Don't** use `transition-all`. Name the properties.
