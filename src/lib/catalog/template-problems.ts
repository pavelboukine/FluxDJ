/**
 * What stops proposals made from a template from being previewed or sent,
 * mirroring the checks in build_offer_snapshot: exactly three distinct
 * packages, exactly one most popular (the recommended package), every
 * package, question and gear item active (included gear, extras, and gear
 * required by the active rules of the asked questions), and every tax
 * category configured. Each problem says how to fix it.
 */

export type TemplateProblem = { text: string; href: string; linkLabel: string };

type Pkg = { id: string; name: string; active: boolean; archivedGear: number; taxCategory: string; gearTaxCategories: string[] };

export function templateProblems(
  t: {
    packages: Pkg[];
    recommendedId: string | null;
    questions: { id: string; prompt: string; active: boolean }[];
    extras: { id: string; name: string; active: boolean }[];
    /** Gear required by the active rules of the asked questions. */
    ruleGear: { id: string; name: string; active: boolean; questionId: string }[];
    configuredTaxCategories: string[];
    /** Tax categories of the extras and of the gear the rules require. */
    gearTaxCategories: string[];
  },
  links: { edit: string; package: (id: string) => string; question: (id: string) => string; gear: (id: string) => string; taxes: string },
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  if (t.packages.length !== 3) {
    problems.push({ text: `It offers ${t.packages.length} of the 3 packages a proposal needs.`, href: links.edit, linkLabel: "Choose packages" });
  }
  if (!t.recommendedId && t.packages.length > 0) {
    problems.push({ text: "No recommended package: a proposal needs exactly one marked most popular.", href: links.edit, linkLabel: "Choose one" });
  }
  for (const p of t.packages.filter((p) => !p.active)) {
    problems.push({ text: `The package ${p.name} is archived.`, href: links.package(p.id), linkLabel: "Restore it or choose another" });
  }
  for (const p of t.packages.filter((p) => p.active && p.archivedGear > 0)) {
    problems.push({ text: `The package ${p.name} includes archived gear.`, href: links.package(p.id), linkLabel: "Review its gear" });
  }
  for (const q of t.questions.filter((q) => !q.active)) {
    problems.push({ text: `The question “${q.prompt}” is archived.`, href: links.question(q.id), linkLabel: "Restore it or remove it" });
  }
  for (const g of t.extras.filter((g) => !g.active)) {
    problems.push({ text: `The extra ${g.name} is archived gear.`, href: links.gear(g.id), linkLabel: "Restore it or remove it" });
  }
  const seen = new Set<string>();
  for (const g of t.ruleGear.filter((g) => !g.active)) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    problems.push({ text: `A rule requires ${g.name}, which is archived gear.`, href: links.question(g.questionId), linkLabel: "Review the rule" });
  }
  const configured = new Set(t.configuredTaxCategories);
  const missing = [...new Set([...t.packages.flatMap((p) => [p.taxCategory, ...p.gearTaxCategories]), ...t.gearTaxCategories])].filter((c) => !configured.has(c));
  if (missing.length > 0) {
    problems.push({ text: `Taxes aren't set up for ${missing.join(", ")}.`, href: links.taxes, linkLabel: "Open tax settings" });
  }
  return problems;
}
