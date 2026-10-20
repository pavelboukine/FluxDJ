import { describe, expect, it } from "vitest";
import { discussLabel, djIdentity, djRef, resolveDjName, withDj } from "@/lib/planning/dj";
import { INTERACTION, INTERACTION_LABELS, preferencesAnswersFromForm, preferencesForm } from "@/lib/planning/contacts";
import { hasOtherMc, mcAnswersFromForm, mcForm } from "@/lib/planning/participants";
import { buildRunSheet } from "@/lib/run-sheet/model";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { pdfPageTexts } from "../support/pdf";
import { input, planView } from "./fixtures/run-sheet";

describe("DJ identity", () => {
  it("uses the event's DJ name, else the business's DJ name, else none (never the business display name)", () => {
    expect(resolveDjName("DJ Sam", "DJ Boukine")).toBe("DJ Sam");
    expect(resolveDjName(null, "DJ Boukine")).toBe("DJ Boukine");
    expect(resolveDjName("   ", " DJ Boukine ")).toBe("DJ Boukine");
    expect(resolveDjName(undefined, null)).toBeNull();
  });

  it("names the DJ only where planning asks who does what, with a generic fallback", () => {
    expect(djIdentity("DJ Boukine", "client")).toBe("DJ Boukine (your DJ)");
    expect(djIdentity("DJ Boukine", "staff")).toBe("DJ Boukine (the DJ)");
    expect(djIdentity(null, "client")).toBe("Your DJ");
    expect(djIdentity("", "staff")).toBe("The DJ");
  });

  it("says “your DJ” to clients and “the DJ” to staff in generic wording and discussion choices", () => {
    expect(djRef("client")).toBe("your DJ");
    expect(discussLabel("client")).toBe("Not sure yet — discuss with your DJ");
    expect(discussLabel("staff")).toBe("Not sure yet — discuss with the DJ");
    expect(withDj(INTERACTION, "client").at(-1)).toEqual({ value: "discuss", label: "Not sure yet — discuss with your DJ" });
  });
});

describe("DJ microphone interaction", () => {
  it("offers minimal, a little, energetic and not sure; occasional announcements is no longer offered", () => {
    expect(INTERACTION.map(([v, l]) => `${v}:${l}`)).toEqual([
      "music_mostly:Minimal", "a_little:A little interaction", "interactive:Energetic and interactive", "discuss:Not sure yet — discuss with the DJ",
    ]);
    expect(INTERACTION_LABELS.find(([v]) => v === "occasional")?.[1]).toBe("Occasional announcements");
  });

  it("saves the new choice and keeps a saved legacy answer valid", () => {
    const form = preferencesForm({});
    expect(preferencesAnswersFromForm({ ...form, interaction: "a_little" })).toEqual({ ok: true, answers: { interaction: "a_little" } });
    expect(preferencesAnswersFromForm({ ...form, interaction: "occasional", lyrics: "clean" })).toEqual({ ok: true, answers: { interaction: "occasional", lyrics: "clean" } });
    expect(preferencesAnswersFromForm({ ...form, interaction: "chatty" })).toMatchObject({ ok: false, field: "interaction" });
  });
});

describe("MC duties", () => {
  const details = { name: " Kiara Okafor ", pronunciation: "kee-AR-ah", contact: "k@example.test", notes: "Bilingual" };

  it("keeps the other MC's details when someone else is the MC or shares the duties", () => {
    expect(hasOtherMc("shared")).toBe(true);
    expect(hasOtherMc("dj")).toBe(false);
    expect(mcAnswersFromForm({ mc: "shared", ...details })).toEqual({
      ok: true, answers: { mc: "shared", name: "Kiara Okafor", pronunciation: "kee-AR-ah", contact: "k@example.test", notes: "Bilingual" },
    });
    expect(mcAnswersFromForm({ mc: "dj", ...details })).toEqual({ ok: true, answers: { mc: "dj", notes: "Bilingual" } });
  });

  it("keeps a legacy “No MC” answer exactly as saved", () => {
    expect(mcAnswersFromForm(mcForm({ mc: "none", notes: "Couple will improvise" }))).toEqual({ ok: true, answers: { mc: "none", notes: "Couple will improvise" } });
  });
});

describe("run sheet MC lines", () => {
  const sheet = (answers: Record<string, unknown>, djName?: string | null) =>
    buildRunSheet({
      ...input(planView({ stages: [{ key: "reception_entrance", editor: "stage_entrance", label: "Reception entrance", moments: [{ key: "mc", editor: "mc", label: "MC", answers }] }] })),
      djName,
    });
  const mcRow = (s: ReturnType<typeof sheet>) => s.stages[0].rows.find((r) => r.title === "MC")!;
  const essential = (s: ReturnType<typeof sheet>) => s.essentials.find((e) => e.label === "MC")?.value;

  it("names the configured DJ, and never the business name without one", () => {
    expect(mcRow(sheet({ mc: "dj" }, "DJ Boukine")).people).toEqual([{ names: "DJ Boukine (the DJ)" }]);
    expect(essential(sheet({ mc: "dj" }, null))).toBe("The DJ");
    expect(JSON.stringify(sheet({ mc: "dj" }, null).stages)).not.toContain("BOUPROD Test");
  });

  it("shows shared duties with the other MC's name and the DJ, both marked as sharing", () => {
    const s = sheet({ mc: "shared", name: "Kiara Okafor", contact: "k@example.test" }, "DJ Boukine");
    expect(mcRow(s).people).toEqual([
      { names: "DJ Boukine (the DJ)", role: "Shares MC duties" },
      { names: "Kiara Okafor", pronunciation: undefined, role: "Shares MC duties · k@example.test" },
    ]);
    expect(essential(s)).toBe("Shared: DJ Boukine (the DJ) and Kiara Okafor k@example.test");
  });

  it("keeps legacy answers readable: No MC, and an earlier pronunciation guide", () => {
    expect(mcRow(sheet({ mc: "none" })).status).toEqual({ tone: "none", text: "No MC" });
    expect(essential(sheet({ mc: "none" }))).toBe("No MC");
    expect(essential(sheet({ mc: "other", name: "Kiara", pronunciation: "kee-AR-ah" }))).toBe("Kiara [kee-AR-ah]");
  });

  it("prints shared duties in the PDF", async () => {
    const bytes = await renderRunSheetPdf(sheet({ mc: "shared", name: "Kiara Okafor" }, "DJ Boukine"), "0000AAAA");
    const text = (await pdfPageTexts(bytes)).join("\n");
    expect(text).toContain("Shared: DJ Boukine (the DJ) and Kiara Okafor");
    expect(text).toContain("Shares MC duties");
  });
});
