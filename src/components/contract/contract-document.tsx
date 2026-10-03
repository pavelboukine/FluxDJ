import type { TemplateSection } from "@/lib/contracts/template-text";

/**
 * Shows agreement text exactly as stored. Everything is rendered as React
 * text nodes (escaped), never as HTML; line breaks are kept with
 * whitespace-pre-wrap, and long words or hashes wrap instead of widening the
 * page on a phone.
 */
export function ContractDocument({ title, sections, headingLevel = 1 }: { title: string; sections: readonly TemplateSection[]; headingLevel?: 1 | 2 }) {
  const Title = headingLevel === 1 ? "h1" : "h2";
  const Section = headingLevel === 1 ? "h2" : "h3";
  return (
    <article className="mx-auto grid w-full max-w-prose gap-5 text-base leading-relaxed [overflow-wrap:anywhere]">
      <Title className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</Title>
      {sections.map((s, i) => (
        <section key={i} className="grid gap-1.5">
          <Section className="text-lg font-semibold">{s.heading}</Section>
          <p className="whitespace-pre-wrap">{s.body}</p>
        </section>
      ))}
    </article>
  );
}
