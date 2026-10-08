import { describe, expect, it } from "vitest";
import { templateProblems } from "@/lib/catalog/template-problems";

const links = { edit: "#edit", package: (id: string) => `/p/${id}`, question: (id: string) => `/q/${id}`, gear: (id: string) => `/g/${id}`, taxes: "/taxes" };
const pkg = (id: string, extra: Partial<{ active: boolean; archivedGear: number; taxCategory: string; gearTaxCategories: string[] }> = {}) => ({
  id, name: id.toUpperCase(), active: true, archivedGear: 0, taxCategory: "standard", gearTaxCategories: ["standard"], ...extra,
});
const base = { packages: [pkg("a"), pkg("b"), pkg("c")], recommendedId: "b", questions: [], extras: [], ruleGear: [], configuredTaxCategories: ["standard"], gearTaxCategories: [] };

describe("template problems", () => {
  it("reports nothing for a complete template", () => {
    expect(templateProblems(base, links)).toEqual([]);
  });

  it("names each problem with a way to fix it", () => {
    const problems = templateProblems(
      {
        ...base,
        packages: [pkg("a", { active: false }), pkg("b", { archivedGear: 1, taxCategory: "reduced" })],
        recommendedId: null,
        questions: [{ id: "q1", prompt: "Ceremony?", active: false }],
        extras: [{ id: "g1", name: "Fog", active: false }],
        ruleGear: [{ id: "g2", name: "Speaker", active: false, questionId: "q2" }, { id: "g2", name: "Speaker", active: false, questionId: "q3" }],
        gearTaxCategories: ["standard", "rental"],
      },
      links,
    );
    expect(problems.map((p) => [p.text, p.href])).toEqual([
      ["It offers 2 of the 3 packages a proposal needs.", "#edit"],
      ["No recommended package: a proposal needs exactly one marked most popular.", "#edit"],
      ["The package A is archived.", "/p/a"],
      ["The package B includes archived gear.", "/p/b"],
      ["The question “Ceremony?” is archived.", "/q/q1"],
      ["The extra Fog is archived gear.", "/g/g1"],
      ["A rule requires Speaker, which is archived gear.", "/q/q2"],
      ["Taxes aren't set up for reduced, rental.", "/taxes"],
    ]);
  });
});
