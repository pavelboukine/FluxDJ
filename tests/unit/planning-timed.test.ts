import { describe, expect, it } from "vitest";
import { answersKey } from "@/lib/planning/basics";
import {
  arrivalAnswersFromForm,
  arrivalForm,
  emptyTimedEntry,
  programAnswersFromForm,
  programForm,
  timedAnswersFromForm,
  timedEntryResolved,
  timedForm,
  type TimedEditor,
} from "@/lib/planning/timed";

const E1 = "11111111-1111-4111-8111-111111111111";
const entry = (editor: TimedEditor, extra: Partial<ReturnType<typeof emptyTimedEntry>>) => ({ ...emptyTimedEntry(E1, editor), ...extra });

describe("Arrival details (mirror of private.normalize_plan_arrival)", () => {
  it("keeps only each reuse's own fields: reusing the ceremony time stores no time", () => {
    const form = { ...arrivalForm({}), location_source: "ceremony" as const, location_other: "x", time_source: "ceremony" as const, start_time: "15:00", welcome: " Drinks " };
    expect(arrivalAnswersFromForm(form)).toEqual({ ok: true, answers: { location_source: "ceremony", time_source: "ceremony", welcome: "Drinks" } });
  });
  it("needs an explicit next day for an end after midnight", () => {
    const form = { ...arrivalForm({}), location_source: "other" as const, location_other: "Garden", time_source: "time" as const, start_time: "23:30", end_time: "00:15" };
    expect(arrivalAnswersFromForm(form)).toMatchObject({ ok: false, field: "end_time" });
    expect(arrivalAnswersFromForm({ ...form, end_next_day: true })).toMatchObject({ ok: true, answers: { end_time: "00:15", end_next_day: true } });
  });
  it('refuses "No separate arrival arrangements" while details are filled in', () => {
    expect(arrivalAnswersFromForm({ ...arrivalForm({}), arrival_none: true, location_source: "other", location_other: "Garden" })).toMatchObject({ ok: false, field: "arrival_none" });
    expect(arrivalAnswersFromForm({ ...arrivalForm({}), arrival_none: true, welcome: "Straight in" })).toEqual({ ok: true, answers: { arrival_none: true, welcome: "Straight in" } });
  });
});

describe("timed entries (mirror of private.normalize_plan_timed)", () => {
  it("keeps only the chosen timing's fields; next day needs its time", () => {
    const r = timedAnswersFromForm("program", { choice: "", entries: [entry("program", { title: "Slideshow", timing: "cue", cue: " After the main course ", time: "20:00", next_day: true, duration: "5" })] });
    expect(r).toEqual({ ok: true, answers: { entries: [{ id: E1, title: "Slideshow", timing: "cue", cue: "After the main course", duration: 5 }] } });
    const t = timedAnswersFromForm("program", { choice: "", entries: [entry("program", { title: "Late", timing: "time", time: "00:30", next_day: true })] });
    expect(t).toEqual({ ok: true, answers: { entries: [{ id: E1, title: "Late", timing: "time", time: "00:30", next_day: true }] } });
  });

  it("checks names, songs (title and artist, safe links), durations and choices", () => {
    expect(timedAnswersFromForm("activities", { choice: "", entries: [entry("activities", { timing: "undecided" })] })).toMatchObject({ ok: false, field: `entry:${E1}:name` });
    expect(timedAnswersFromForm("activities", { choice: "", entries: [entry("activities", { name: "Shoe game", song_title: "Shoe" })] })).toMatchObject({ ok: false, field: `entry:${E1}:song_artist` });
    expect(timedAnswersFromForm("activities", { choice: "", entries: [entry("activities", { name: "Shoe game", song_title: "S", song_artist: "A", song_link: "http://x.com" })] })).toMatchObject({ ok: false, field: `entry:${E1}:song_link` });
    expect(timedAnswersFromForm("activities", { choice: "", entries: [entry("activities", { name: "Toss", duration: "0" })] })).toMatchObject({ ok: false, field: `entry:${E1}:duration` });
    expect(timedAnswersFromForm("activities", { choice: "none", entries: [entry("activities", { name: "Toss" })] })).toMatchObject({ ok: false, field: "choice" });
    expect(timedAnswersFromForm("program", { choice: "", entries: [entry("program", { title: "x", timing: "anytime" })] })).toMatchObject({ ok: false, field: `entry:${E1}:timing` });
  });

  it("dedications: any time is a timing; a song is needed to count, never invented", () => {
    const unfinished = entry("dedications", { recipient: "Our grandparents" });
    expect(unfinished.timing).toBe("anytime");
    expect(timedAnswersFromForm("dedications", { choice: "", entries: [unfinished] })).toEqual({ ok: true, answers: { entries: [{ id: E1, recipient: "Our grandparents", timing: "anytime" }] } });
    expect(timedEntryResolved("dedications", unfinished)).toBe(false);
    expect(timedEntryResolved("dedications", { ...unfinished, song_title: "Moon River", song_artist: "Andy Williams" })).toBe(true);
    expect(timedEntryResolved("activities", entry("activities", { name: "Toss", timing: "cue", cue: "" }))).toBe(false);
  });

  it("round-trips saved answers unchanged, the program's own times and host included", () => {
    const savedProgram = { start_time: "19:00", host: "Kiara", entries: [{ id: E1, title: "Welcome", timing: "time" as const, time: "19:00", duration: 5 }] };
    const p = programAnswersFromForm(programForm(savedProgram));
    expect(p.ok && answersKey(p.answers)).toBe(answersKey(savedProgram));
    const savedDedication = { entries: [{ id: E1, recipient: "Team Lee", timing: "cue" as const, cue: "Last hour", song_title: "Jump", song_artist: "Van Halen" }], choice: "discuss" as const };
    const d = timedAnswersFromForm("dedications", timedForm("dedications", savedDedication));
    expect(d.ok && answersKey(d.answers)).toBe(answersKey(savedDedication));
  });

  it("refuses a program ending before it starts without next day", () => {
    expect(programAnswersFromForm({ ...programForm({}), start_time: "19:00", end_time: "18:00" })).toMatchObject({ ok: false, field: "end_time" });
  });
});
