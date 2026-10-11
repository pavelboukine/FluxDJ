/**
 * Contract template sections: a heading and a plain-text body each. The
 * section editor posts them as repeated "heading" and "body" fields
 * (readSections). The older one-field text form, where each section starts
 * with a line "## Heading", is still converted here (parseTemplateText,
 * sectionsToText) for the DEMO starting text. Nothing here interprets markup:
 * bodies are stored and shown exactly as typed. Placeholder validation happens
 * in the database, against the single placeholder registry.
 */

export type TemplateSection = { heading: string; body: string };

export const MAX_SECTIONS = 60;
const HEADING = /^## (.*)$/;

export type ParseResult = { ok: true; sections: TemplateSection[] } | { ok: false; error: string };

export function parseTemplateText(text: string): ParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      sections.push({ heading: heading[1].trim(), lines: [] });
    } else if (sections.length === 0) {
      if (line.trim() !== "") return { ok: false, error: 'Start the text with a section heading line, for example "## Parties".' };
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  if (sections.length === 0) return { ok: false, error: 'Add at least one section. Start each section with a line like "## Parties".' };
  if (sections.length > MAX_SECTIONS) return { ok: false, error: `A template can have at most ${MAX_SECTIONS} sections.` };

  const result: TemplateSection[] = [];
  for (const [index, section] of sections.entries()) {
    const label = section.heading || `section ${index + 1}`;
    if (!section.heading) return { ok: false, error: `Section ${index + 1} needs a heading after "## ".` };
    if (section.heading.length > 200) return { ok: false, error: `The heading of ${label} is longer than 200 characters.` };
    // Keep the text exactly as typed, minus blank lines around it and trailing spaces.
    const body = section.lines
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
    if (!body.trim()) return { ok: false, error: `Section "${label}" has no text.` };
    if (body.length > 20000) return { ok: false, error: `Section "${label}" is longer than 20,000 characters.` };
    result.push({ heading: section.heading, body });
  }
  return { ok: true, sections: result };
}

export function sectionsToText(sections: readonly TemplateSection[]): string {
  return sections.map((s) => `## ${s.heading}\n${s.body}`).join("\n\n");
}

/** Limits of private.contract_template_problem, mirrored for messages next to the fields (the database stays authoritative). */
export const LIMITS = { title: 300, heading: 200, body: 20000, sections: MAX_SECTIONS } as const;

/** What the database would refuse in one section, in plain words, or null. */
export function sectionProblem(section: TemplateSection): string | null {
  if (!section.heading.trim()) return "Add a heading.";
  if (/[\r\n]/.test(section.heading)) return "Keep the heading on one line.";
  if (section.heading.trim().length > LIMITS.heading) return `Shorten the heading to ${LIMITS.heading} characters.`;
  if (!section.body.trim()) return "Add the section's text.";
  if (section.body.trim().length > LIMITS.body) return `This section is longer than ${LIMITS.body.toLocaleString("en-CA")} characters. Split it into two sections.`;
  if (/(^|\n)## /.test(section.body)) return 'A line can\'t start with "## ".';
  return null;
}

/**
 * The sections a section editor posted: repeated "heading" and "body" fields
 * in document order. Bodies are kept as typed, minus trailing spaces and blank
 * lines around them (as parseTemplateText does).
 */
export function readSections(form: FormData): ParseResult {
  const headings = form.getAll("heading").map((v) => (typeof v === "string" ? v.trim() : ""));
  const bodies = form.getAll("body").map((v) => (typeof v === "string" ? v : ""));
  if (headings.length === 0 || headings.length !== bodies.length) return { ok: false, error: "Add at least one section." };
  if (headings.length > MAX_SECTIONS) return { ok: false, error: `A template can have at most ${MAX_SECTIONS} sections.` };
  const sections = headings.map((heading, i) => ({
    heading,
    body: bodies[i].replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/^\n+|\n+$/g, ""),
  }));
  for (const [i, s] of sections.entries()) {
    const problem = sectionProblem(s);
    if (problem) return { ok: false, error: `Section ${i + 1}${s.heading ? ` (${s.heading})` : ""}: ${problem}` };
  }
  return { ok: true, sections };
}
