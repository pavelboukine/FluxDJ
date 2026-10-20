"use client";

import {
  GENRES,
  INTERACTION,
  INTERACTION_HINTS,
  INTERACTION_LEGACY,
  LYRICS,
  REQUESTS,
  SLOW_SONGS,
  VENDOR_ROLES,
  contactsAnswersFromForm,
  contactsForm,
  emptyVendor,
  musicStyleAnswersFromForm,
  musicStyleForm,
  preferencesAnswersFromForm,
  preferencesForm,
  roleLabel,
  vendorProblem,
  type ContactsAnswers,
  type ContactsForm,
  type DayOfSource,
  type EventContact,
  type MusicStyleAnswers,
  type MusicStyleForm,
  type PreferencesAnswers,
  type PreferencesForm,
  type VendorForm,
  vendorReachable,
} from "@/lib/planning/contacts";
import { selectClass } from "@/components/app/fields";
import { djIdentity, djRef, withDj } from "@/lib/planning/dj";
import { FieldBox, LanguageSelect, describedBy } from "./basics-editor";
import { Choices, EntryList, Frame, text, type Common } from "./participants-editor";
import { useEditingClosed, useLanguageBinding, usePlanProgress } from "./progress";
import { SaveStatus, useAutosave } from "./use-autosave";

/** People already in the plan, shown where useful and never re-entered. */
export type KnownPeople = {
  /** dj: the DJ is the MC or shares the duties; name: the other MC, when there is one. */
  mc: { name?: string; contact?: string; dj: boolean; other: boolean } | null;
  officiant: { name?: string; contact?: string } | null;
};

// ---------------------------------------------------------------------------
// Contacts and vendors
// ---------------------------------------------------------------------------

export function ContactsEditor(props: Common<ContactsAnswers> & { eventContacts: EventContact[]; known: KnownPeople }) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<ContactsForm, ContactsAnswers>({
    initialForm: contactsForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: contactsAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const id = (f: string) => `${props.momentKey}-${f}`;
  const chosen = props.eventContacts.find((c) => c.id === form.day_of_client_id);
  const unavailable = form.day_of_source === "event_contact" && form.day_of_client_id !== "" && !chosen;
  const { mc, officiant } = props.known;
  const dj = djRef(props.audience);

  return (
    <Frame props={props as Common<unknown>} status={<SaveStatus saveState={saveState} message={message} retry={retry} />}>
      {mc || officiant ? (
        <div className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm" data-testid="known-people">
          <p className="font-medium">Already in your plan</p>
          {mc ? (
            <p className="[overflow-wrap:anywhere]">
              MC: {[mc.dj ? djIdentity(props.djDisplayName, props.audience) : null, mc.other ? mc.name ?? "another MC, name not entered yet" : null].filter(Boolean).join(" and ")}
              {mc.contact ? ` · ${mc.contact}` : ""} <span className="text-xs text-muted-foreground">(change it under Reception entrance → MC)</span>
            </p>
          ) : null}
          {officiant ? (
            <p className="[overflow-wrap:anywhere]">
              Officiant: {officiant.name ?? "name not entered yet"}
              {officiant.contact ? ` · ${officiant.contact}` : ""} <span className="text-xs text-muted-foreground">(change it under Ceremony details)</span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">No need to list them again as vendors.</p>
        </div>
      ) : null}

      <section className="grid gap-2" aria-label="Day-of contact">
        <Choices<DayOfSource>
          name={id("day_of_source")}
          legend="Day-of contact for the DJ (needed)"
          value={form.day_of_source}
          disabled={readOnly}
          onChange={(v) => update({ day_of_source: v as DayOfSource | "" }, ["day_of_source", "day_of_client_id"])}
          error={errorFor("day_of_source")}
          options={[
            { value: "event_contact", label: "One of the event's contacts", blocked: props.eventContacts.length === 0 ? "No event contacts yet." : null },
            { value: "other", label: "Someone else" },
            { value: "undecided", label: "Not decided yet" },
          ]}
        />
        {form.day_of_source === "event_contact" || form.day_of_source === "other" ? (
          <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Day-of contact details</legend>
            {form.day_of_source === "event_contact" ? (
              <>
                <FieldBox id={id("day_of_client_id")} label="Contact" error={errorFor("day_of_client_id")} className="col-span-full"
                  hint={unavailable ? "That contact isn't on this event any more. Choose another contact or enter someone." : "The event's contacts as your DJ has them. Planning never changes them."}>
                  <select id={id("day_of_client_id")} className={selectClass} value={form.day_of_client_id} aria-describedby={describedBy(id("day_of_client_id"), errorFor("day_of_client_id"), "hint")}
                    onChange={(e) => update({ day_of_client_id: e.target.value }, ["day_of_client_id"])}>
                    <option value="">Choose a contact</option>
                    {unavailable ? <option value={form.day_of_client_id}>No longer on this event</option> : null}
                    {props.eventContacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.phone ? ` (${c.phone})` : " (no phone on file)"}</option>)}
                  </select>
                </FieldBox>
                {text(id("day_of_phone"), chosen?.phone ? "Different phone for the day (optional)" : "Phone for the day (needed)", form.day_of_phone,
                  (v) => update({ day_of_phone: v }, ["day_of_phone"]), errorFor("day_of_phone"),
                  { hint: "Used for this event's planning only; it doesn't change the contact's details." })}
              </>
            ) : null}
            {form.day_of_source === "other" ? (
              <>
                {text(id("day_of_name"), "Name (needed)", form.day_of_name, (v) => update({ day_of_name: v }, ["day_of_name"]), errorFor("day_of_name"))}
                {text(id("day_of_phone"), "Phone (needed)", form.day_of_phone, (v) => update({ day_of_phone: v }, ["day_of_phone"]), errorFor("day_of_phone"))}
                {text(id("day_of_role"), "Relationship or role (optional)", form.day_of_role, (v) => update({ day_of_role: v }, ["day_of_role"]), errorFor("day_of_role"), { hint: "For example: maid of honour, planner, brother.", wide: true })}
              </>
            ) : null}
          </fieldset>
        ) : null}
      </section>

      <section className="grid gap-2 border-t pt-3" aria-label="Vendors">
        <Choices<"none">
          name={id("vendors_choice")}
          legend="Other vendors the DJ may coordinate with (needed)"
          value={form.vendors_choice}
          disabled={readOnly}
          onChange={(v) => update({ vendors_choice: v as "" | "none" }, ["vendors_choice"])}
          error={errorFor("vendors_choice")}
          options={[
            { value: "", label: "I'll list them" },
            { value: "none", label: "No additional vendor contacts", blocked: form.vendors.length > 0 ? "Remove the vendors to choose this." : null },
          ]}
        />
        <p className="text-xs text-muted-foreground">Only the ones the DJ may need; no category is required. Notes here are shared with you and {dj}.</p>
        <EntryList<VendorForm>
          base={id("vendors")}
          noun="Vendor"
          entries={form.vendors}
          setEntries={(vendors, clears) => update({ vendors }, [...(clears ?? []), "vendors"])}
          readOnly={readOnly}
          canAdd={form.vendors_choice !== "none"}
          addBlockedText={'To add vendors, choose "I\'ll list them" above.'}
          max={30}
          nameOf={(v) => v.name.trim() || v.business.trim() || "Unnamed vendor"}
          summary={(v, index) => (
            <>
              <p className="font-medium [overflow-wrap:anywhere]">
                {index + 1}. {roleLabel(v.role)}: {[v.name.trim(), v.business.trim()].filter(Boolean).join(", ") || "Unnamed"}
              </p>
              {vendorReachable(v) ? (
                <p className="text-xs [overflow-wrap:anywhere]">{[v.phone.trim(), v.email.trim()].filter(Boolean).join(" · ")}</p>
              ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400">No phone or email yet. Edit to add one so {dj} can reach them.</p>
              )}
              {v.notes.trim() ? <p className="whitespace-pre-line text-xs [overflow-wrap:anywhere]">Shared notes: {v.notes}</p> : null}
            </>
          )}
          fields={(v, onChange, entryError, prefix) => (
            <>
              <FieldBox id={`${prefix}-role`} label="Role" error={entryError("role")} className="col-span-full">
                <select id={`${prefix}-role`} className={selectClass} value={v.role} aria-invalid={Boolean(entryError("role"))} aria-describedby={describedBy(`${prefix}-role`, entryError("role"))} onChange={(e) => onChange({ role: e.target.value as VendorForm["role"] })}>
                  <option value="">Choose a role</option>
                  {VENDOR_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </FieldBox>
              {text(`${prefix}-name`, "Person's name", v.name, (x) => onChange({ name: x }), entryError("name"), { hint: "A name or a business name is needed." })}
              {text(`${prefix}-business`, "Business name (optional)", v.business, (x) => onChange({ business: x }), entryError("business"))}
              <fieldset className="grid gap-3 col-span-full sm:grid-cols-2" aria-describedby={`${prefix}-reach-hint`}>
                <legend className="mb-1 text-sm font-medium">How to reach them (phone or email needed)</legend>
                {text(`${prefix}-phone`, "Phone", v.phone, (x) => onChange({ phone: x }), entryError("phone"), { type: "tel", inputMode: "tel", autoComplete: "off" })}
                {text(`${prefix}-email`, "Email", v.email, (x) => onChange({ email: x }), entryError("email"), { type: "email", inputMode: "email", autoComplete: "off" })}
                <p id={`${prefix}-reach-hint`} className="text-xs text-muted-foreground col-span-full">
                  Provide at least a phone number or email so {dj} can contact this vendor if needed.
                </p>
              </fieldset>
              {text(`${prefix}-notes`, "Coordination notes (optional, shared with you and the DJ)", v.notes, (x) => onChange({ notes: x }), entryError("notes"), { rows: 2 })}
            </>
          )}
          newEntry={emptyVendor}
          check={(v) => vendorProblem(v)}
          fieldError={fieldError}
        />
        {fieldError?.field === "vendors" ? <p role="alert" className="text-xs text-destructive">{fieldError.message}</p> : null}
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// DJ expectations and overall preferences
// ---------------------------------------------------------------------------

export function PreferencesEditor(props: Common<PreferencesAnswers>) {
  const readOnly = useEditingClosed(props.disabledReason);
  const plan = usePlanProgress();
  const { form, update, saveState, message, fieldError, retry } = useAutosave<PreferencesForm, PreferencesAnswers>({
    initialForm: preferencesForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: preferencesAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const id = (f: string) => `${props.momentKey}-${f}`;
  const dj = djRef(props.audience);
  // Stored with Event basics and saved by its editor (see LanguageBinding); asked here, where it belongs.
  const language = useLanguageBinding();
  const savedLanguage = plan?.basics.announcement_language ?? "";
  const languageId = id("announcement_language");
  const languageHint = `The language ${dj} uses for announcements and introductions.`;
  return (
    <Frame
      props={props as Common<unknown>}
      hint={`Instructions for ${dj} to review; they don't change the contracted services or price.`}
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <fieldset disabled={readOnly} className="grid gap-4">
        <legend className="sr-only">DJ expectations and overall preferences</legend>
        {text(id("atmosphere"), "Desired atmosphere and what matters most (optional)", form.atmosphere, (v) => update({ atmosphere: v }, ["atmosphere"]), errorFor("atmosphere"), { rows: 3, hint: "For example: elegant dinner, then a packed dance floor; keep grandparents in mind." })}
        <Choices name={id("interaction")} legend="How much would you like your DJ to interact with guests on the microphone? (needed)" value={form.interaction}
          onChange={(v) => update({ interaction: v }, ["interaction"])} error={errorFor("interaction")} options={interactionOptions(props.audience, form.interaction, props.initialAnswers.interaction)} />
        <div className="grid gap-1.5" data-testid="announcement-language">
          <FieldBox id={languageId} label="Announcement language (needed)" error={language?.error ?? null} hint={languageHint} className="sm:max-w-sm">
            <LanguageSelect id={languageId} value={language?.value ?? savedLanguage} onChange={(v) => language?.set(v)} error={language?.error ?? null} hint={languageHint} disabled={!language} />
          </FieldBox>
          {/* Saved with Event basics: say so only while that save is pending or failed. */}
          {!language || language.value === savedLanguage || language.error ? null : language.saveState === "invalid" ? (
            <p role="alert" className="text-sm text-destructive">Not saved yet: an answer in Event basics needs fixing first.</p>
          ) : (
            <SaveStatus saveState={language.saveState} message={language.message} retry={language.retry} />
          )}
        </div>
        <Choices name={id("lyrics")} legend="Explicit lyrics (needed)" value={form.lyrics} onChange={(v) => update({ lyrics: v }, ["lyrics"])} error={errorFor("lyrics")} options={withDj(LYRICS, props.audience)} />
        <Choices name={id("requests")} legend="Guest song requests (needed)" value={form.requests} onChange={(v) => update({ requests: v }, ["requests"])} error={errorFor("requests")} options={withDj(REQUESTS, props.audience)} />
        {text(id("notes"), "Practical preferences or concerns (optional)", form.notes, (v) => update({ notes: v }, ["notes"]), errorFor("notes"), { rows: 3, hint: "For example: keep the volume moderate during dinner." })}
      </fieldset>
    </Frame>
  );
}

/**
 * The DJ's microphone interaction (not formal MC duties, asked under Reception
 * entrance → MC). "Occasional announcements" is no longer offered; a saved one
 * is still shown, selected, until changed.
 */
function interactionOptions(audience: "client" | "staff", current: string, saved: string | undefined) {
  const options: { value: string; label: string; hint?: string }[] = withDj(INTERACTION, audience).map((o) => ({ ...o, hint: INTERACTION_HINTS[o.value] }));
  if (current === "occasional" || saved === "occasional") {
    options.push({ value: "occasional", label: INTERACTION_LEGACY.occasional, hint: "An earlier answer that is no longer offered. Choose another option to update it." });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Party music preferences
// ---------------------------------------------------------------------------

export function MusicStyleEditor(props: Common<MusicStyleAnswers>) {
  const readOnly = useEditingClosed(props.disabledReason);
  const { form, update, saveState, message, fieldError, retry } = useAutosave<MusicStyleForm, MusicStyleAnswers>({
    initialForm: musicStyleForm(props.initialAnswers),
    initialAnswers: props.initialAnswers,
    initialRevision: props.initialRevision,
    parse: musicStyleAnswersFromForm,
    save: props.save,
    readOnly,
  });
  const errorFor = (f: string) => (fieldError?.field === f ? fieldError.message : null);
  const id = (f: string) => `${props.momentKey}-${f}`;
  const dj = djRef(props.audience);
  const djChoice = form.style_choice === "dj_choice";
  const hasStyles = form.genres.length > 0 || form.other_style.trim() !== "";
  return (
    <Frame
      props={props as Common<unknown>}
      hint="Overall styles for the dance floor. Specific songs go under Must play, Play if possible and Do not play."
      status={<SaveStatus saveState={saveState} message={message} retry={retry} />}
    >
      <fieldset disabled={readOnly} className="grid gap-4">
        <legend className="sr-only">Music preferences</legend>
        <Choices<"dj_choice">
          name={id("style_choice")}
          legend="Music styles (needed)"
          value={form.style_choice}
          onChange={(v) => update({ style_choice: v as "" | "dj_choice" }, ["style_choice"])}
          error={errorFor("style_choice")}
          options={[
            { value: "", label: "I'll pick styles" },
            { value: "dj_choice", label: `${dj.charAt(0).toUpperCase()}${dj.slice(1)}'s choice`, blocked: hasStyles ? "Clear the styles to choose this." : null },
          ]}
        />
        {!djChoice ? (
          <div className="grid gap-2">
            <fieldset className="grid gap-1 sm:grid-cols-2">
              <legend className="mb-1 text-sm font-medium">Styles (choose any)</legend>
              {GENRES.map(([value, label]) => (
                <label key={value} className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={form.genres.includes(value)}
                    onChange={(e) => update({ genres: e.target.checked ? [...form.genres, value] : form.genres.filter((g) => g !== value) }, ["genres", "style_choice"])}
                  />
                  {label}
                </label>
              ))}
              {errorFor("genres") ? <p className="text-xs text-destructive">{errorFor("genres")}</p> : null}
            </fieldset>
            {text(id("other_style"), "Other style (optional)", form.other_style, (v) => update({ other_style: v }, ["other_style", "style_choice"]), errorFor("other_style"), { hint: "For example: Afrobeats, K-pop, 80s French pop." })}
          </div>
        ) : null}
        {text(id("favorite_artists"), "Favourite artists (optional)", form.favorite_artists, (v) => update({ favorite_artists: v }, ["favorite_artists"]), errorFor("favorite_artists"), { rows: 2 })}
        {text(id("dance_floor"), "Dance-floor atmosphere (optional)", form.dance_floor, (v) => update({ dance_floor: v }, ["dance_floor"]), errorFor("dance_floor"), { rows: 2, hint: "For example: build up slowly, peak late, mix generations." })}
        <Choices name={id("slow_songs")} legend="Slow songs during the party (needed)" value={form.slow_songs} onChange={(v) => update({ slow_songs: v }, ["slow_songs"])} error={errorFor("slow_songs")} options={withDj(SLOW_SONGS, props.audience)} />
      </fieldset>
    </Frame>
  );
}

