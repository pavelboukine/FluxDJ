/**
 * The contract template editor uses one plain-text field. Each section starts
 * with a line "## Heading"; everything up to the next such line is the
 * section's text. This file converts between that text and the structured
 * sections stored in the database. Nothing here interprets markup: bodies are
 * stored and shown exactly as typed. Placeholder validation happens in the
 * database, against the single placeholder registry.
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
