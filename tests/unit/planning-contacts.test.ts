import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import {
  contactsAnswersFromForm,
  contactsForm,
  emptyVendor,
  isEmail,
  isPhone,
  musicStyleAnswersFromForm,
  musicStyleForm,
  preferencesAnswersFromForm,
  preferencesForm,
  vendorProblem,
} from "@/lib/planning/contacts";

const C1 = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const blank = contactsForm({});

describe("phone and email checks (mirror of private.is_phone / is_email)", () => {
  it("accepts phones as people write them, 7 to 20 digits", () => {
    for (const p of ["514 555-0100", "+1 (514) 555-0100", "514.555.0100", "5145550100"]) expect(isPhone(p)).toBe(true);
    for (const p of ["12", "call me", "514-555-0100 ext. 2", "+".padEnd(25, "1")]) expect(isPhone(p)).toBe(false);
  });
  it("accepts plausible emails only", () => {
    expect(isEmail("sasha@dayof.test")).toBe(true);
    for (const e of ["jo@", "jo@example", "jo smith@example.com"]) expect(isEmail(e)).toBe(false);
  });
});

describe("contacts (mirror of private.normalize_plan_contacts)", () => {
  it("keeps only the chosen day-of source's fields: a reference stores the id, never a copy", () => {
    const form = { ...blank, day_of_source: "event_contact" as const, day_of_client_id: C1, day_of_name: "Ignored", day_of_role: "Ignored", day_of_phone: " 514 555-0111 " };
    expect(contactsAnswersFromForm(form)).toEqual({ ok: true, answers: { day_of_source: "event_contact", day_of_client_id: C1, day_of_phone: "514 555-0111" } });
    expect(contactsAnswersFromForm({ ...form, day_of_source: "other" })).toEqual({ ok: true, answers: { day_of_source: "other", day_of_name: "Ignored", day_of_role: "Ignored", day_of_phone: "514 555-0111" } });
    expect(contactsAnswersFromForm({ ...form, day_of_source: "undecided" })).toEqual({ ok: true, answers: { day_of_source: "undecided" } });
  });

  it("checks phones, vendor roles, names, phones and emails", () => {
    expect(contactsAnswersFromForm({ ...blank, day_of_source: "other", day_of_phone: "call me" })).toMatchObject({ ok: false, field: "day_of_phone" });
    expect(vendorProblem({ ...emptyVendor(V1), name: "Jo" })).toMatchObject({ field: "role" });
    expect(vendorProblem({ ...emptyVendor(V1), role: "photographer" })).toMatchObject({ field: "name" });
    expect(vendorProblem({ ...emptyVendor(V1), role: "photographer", business: "Lumière", phone: "12" })).toMatchObject({ field: "phone" });
    expect(vendorProblem({ ...emptyVendor(V1), role: "photographer", business: "Lumière", email: "jo@" })).toMatchObject({ field: "email" });
    expect(vendorProblem({ ...emptyVendor(V1), role: "photographer", business: "Lumière", email: "photos@lumiere.test" })).toBeNull();
    expect(contactsAnswersFromForm({ ...blank, vendors: [{ ...emptyVendor(V1), role: "venue" }] })).toMatchObject({ ok: false, field: `entry:${V1}:name` });
  });

  it("needs a phone or an email for a vendor; either one is enough (mirror of check_plan_vendor_reach)", () => {
    const vendor = { ...emptyVendor(V1), role: "videographer" as const, name: "Remy" };
    expect(vendorProblem(vendor)).toEqual({ field: "phone", message: "Enter a phone number or an email address for this vendor." });
    expect(vendorProblem({ ...vendor, phone: "   ", email: " " })).toMatchObject({ field: "phone" });
    expect(vendorProblem({ ...vendor, phone: "514 555-0100" })).toBeNull();
    expect(vendorProblem({ ...vendor, email: "remy@films.test" })).toBeNull();
    expect(contactsAnswersFromForm({ ...blank, vendors: [vendor] })).toMatchObject({ ok: false, field: `entry:${V1}:phone` });
    // Business name stays optional.
    expect(contactsAnswersFromForm({ ...blank, vendors: [{ ...vendor, email: " remy@films.test " }] }))
      .toEqual({ ok: true, answers: { vendors: [{ id: V1, role: "videographer", name: "Remy", email: "remy@films.test" }] } });
  });

  it("keeps vendors saved without a phone or email before that rule, and never blocks the other answers for them", () => {
    const saved = { day_of_source: "undecided" as const, vendors: [{ id: V1, role: "venue" as const, name: "Pat" }] };
    const form = contactsForm(saved);
    expect(form.unreachable).toEqual([V1]);
    // The day-of contact changes; the older vendor is saved as it was, and can be renamed.
    const renamed = { ...form, day_of_source: "other" as const, day_of_name: "Morgan", day_of_phone: "514 555-0142", vendors: [{ ...form.vendors[0], name: "Pat Venue" }] };
    expect(contactsAnswersFromForm(renamed)).toEqual({ ok: true, answers: {
      day_of_source: "other", day_of_name: "Morgan", day_of_phone: "514 555-0142", vendors: [{ id: V1, role: "venue", name: "Pat Venue" }],
    } });
    // A vendor saved with a phone or email isn't exempt, and nor is a new one.
    expect(contactsForm({ vendors: [{ id: V1, role: "venue", name: "Pat", phone: "514 555-0188" }] }).unreachable).toEqual([]);
    expect(contactsAnswersFromForm({ ...blank, vendors: [{ ...emptyVendor(V1), role: "venue", name: "Pat" }] })).toMatchObject({ ok: false, field: `entry:${V1}:phone` });
  });

  it('refuses "No additional vendor contacts" while vendors are listed; round-trips saved answers', () => {
    const vendor = { ...emptyVendor(V1), role: "planner" as const, name: " Sasha ", phone: "514 555-0123", notes: "Shared note" };
    expect(contactsAnswersFromForm({ ...blank, vendors: [vendor], vendors_choice: "none" })).toMatchObject({ ok: false, field: "vendors_choice" });
    const saved = { day_of_source: "other" as const, day_of_name: "Morgan", day_of_phone: "514 555-0142", vendors: [{ id: V1, role: "planner" as const, name: "Sasha", email: "sasha@dayof.test", notes: "Shared note" }] };
    const again = contactsAnswersFromForm(contactsForm(saved));
    expect(again.ok && answersKey(again.answers)).toBe(answersKey(saved));
  });
});

describe("DJ expectations", () => {
  it("keeps the listed choices and text; the language is never stored here", () => {
    const r = preferencesAnswersFromForm({ ...preferencesForm({}), interaction: "interactive", lyrics: "clean", requests: "welcome", atmosphere: "  Elegant " });
    expect(r).toEqual({ ok: true, answers: { interaction: "interactive", lyrics: "clean", requests: "welcome", atmosphere: "Elegant" } });
    expect(preferencesAnswersFromForm({ ...preferencesForm({}), lyrics: "sometimes" })).toMatchObject({ ok: false, field: "lyrics" });
  });
});

describe("Party music preferences", () => {
  it("keeps styles once in the list order; DJ's choice excludes styles", () => {
    expect(musicStyleAnswersFromForm({ ...musicStyleForm({}), genres: ["rock", "pop", "rock"], slow_songs: "a_few" }))
      .toEqual({ ok: true, answers: { genres: ["pop", "rock"], slow_songs: "a_few" } });
    expect(musicStyleAnswersFromForm({ ...musicStyleForm({}), genres: ["pop"], style_choice: "dj_choice" })).toMatchObject({ ok: false, field: "style_choice" });
    expect(musicStyleAnswersFromForm({ ...musicStyleForm({}), other_style: "Afrobeats", style_choice: "dj_choice" })).toMatchObject({ ok: false, field: "style_choice" });
    expect(musicStyleAnswersFromForm({ ...musicStyleForm({}), genres: ["polka"] })).toMatchObject({ ok: false, field: "genres" });
    expect(musicStyleAnswersFromForm({ ...musicStyleForm({}), style_choice: "dj_choice", slow_songs: "discuss" })).toEqual({ ok: true, answers: { style_choice: "dj_choice", slow_songs: "discuss" } });
  });
});
