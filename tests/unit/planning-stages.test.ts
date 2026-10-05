import { describe, expect, it } from "vitest";
import { STAGE_LAYOUT, STAGE_FIELDS, STAGE_EDITORS, minutesOf, nextDayLabel, stageAnswersFromForm, stageFormFromAnswers } from "@/lib/planning/stages";

describe("stage detail validation (mirrors the database)", () => {
  it("normalizes partial answers: trims text, drops blanks and a next-day mark without its time", () => {
    const form = { ...stageFormFromAnswers("stage_ceremony", {}), start_time: "16:00", officiant_name: "  Sam  ", location_area: " ", end_next_day: true };
    expect(stageAnswersFromForm("stage_ceremony", form)).toEqual({ ok: true, answers: { start_time: "16:00", officiant_name: "Sam" } });
  });

  it("never reads an end before its start as overnight; an explicit next day makes it valid", () => {
    const base = { ...stageFormFromAnswers("stage_party", {}), start_time: "22:00", end_time: "01:00" };
    expect(stageAnswersFromForm("stage_party", base)).toMatchObject({ ok: false, field: "end_time" });
    expect(stageAnswersFromForm("stage_party", { ...base, end_time: "22:00" })).toMatchObject({ ok: false, field: "end_time" });
    expect(stageAnswersFromForm("stage_party", { ...base, end_next_day: true })).toEqual({
      ok: true, answers: { start_time: "22:00", end_time: "01:00", end_next_day: true },
    });
  });

  it("refuses malformed times, unknown choices, out-of-range counts and conflicting entrance answers", () => {
    const f = (editor: Parameters<typeof stageFormFromAnswers>[0], changes: Record<string, string | boolean>) =>
      stageAnswersFromForm(editor, { ...stageFormFromAnswers(editor, {}), ...changes });
    expect(f("stage_cocktail", { start_time: "5pm" })).toMatchObject({ ok: false, message: "Enter a time such as 18:30." });
    expect(f("stage_ceremony", { microphones: "maybe" })).toMatchObject({ ok: false, field: "microphones" });
    expect(f("stage_dinner", { guest_count: "0" })).toMatchObject({ ok: false, field: "guest_count" });
    expect(f("stage_party", { evening_guests: "0" })).toEqual({ ok: true, answers: { evening_guests: 0 } });
    expect(f("stage_entrance", { entrance_time: "19:00", entrance_none: true })).toMatchObject({ ok: false, field: "entrance_time" });
    expect(f("stage_cocktail", { atmosphere: "x".repeat(1001) })).toMatchObject({ ok: false, field: "atmosphere" });
  });

  it("round-trips saved answers through the form", () => {
    const answers = { location_source: "other", location_other: "Barn", finish_source: "time" };
    const saved = { location_source: "other", location_other: "Barn", start_time: "20:00", end_time: "00:30", end_next_day: true as const, evening_guests: 12 };
    expect(stageAnswersFromForm("stage_party", stageFormFromAnswers("stage_party", saved))).toEqual({ ok: true, answers: saved });
    expect(stageFormFromAnswers("stage_party", answers).end_next_day).toBe(false);
  });

  it("counts minutes from the event day, next day included", () => {
    expect(minutesOf({ finish_time: "01:30", finish_next_day: true }, "finish")).toBe(1530);
    expect(minutesOf({ start_time: "18:00" }, "start")).toBe(1080);
    expect(minutesOf({}, "start")).toBeNull();
    expect(nextDayLabel("2027-08-14")).toBe("Sun, Aug 15");
    expect(nextDayLabel("2027-12-31")).toBe("Sat, Jan 1");
  });

  it("lays out only stored fields", () => {
    for (const editor of STAGE_EDITORS) {
      const fields = STAGE_FIELDS[editor];
      for (const b of STAGE_LAYOUT[editor]) {
        if (b.type === "time") expect(fields[`${b.prefix}_time`]).toBeDefined();
        if (b.type === "text" || b.type === "choice" || b.type === "int" || b.type === "flag") expect(fields[b.field]).toBeDefined();
        if (b.type === "location") expect(fields.location_source).toBeDefined();
      }
    }
  });
});
