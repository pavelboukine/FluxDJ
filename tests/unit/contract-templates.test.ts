import { describe, expect, it } from "vitest";
import { DEMO_TEMPLATE_SECTIONS, DEMO_TEMPLATE_TEXT, DEMO_TEMPLATE_TITLE } from "@/lib/contracts/demo-template";
import { parseTemplateText, sectionsToText } from "@/lib/contracts/template-text";
import { describeDbError } from "@/lib/db-errors";

describe("contract template text format", () => {
  it("parses '## Heading' sections and keeps the text exactly as typed", () => {
    const parsed = parseTemplateText("## Parties\nBetween {{business.name}}\n  and {{client.name}}.\n\n\n## Payment\n- Deposit: {{payment.deposit}}\n- Balance: {{payment.balance}}\n");
    expect(parsed).toEqual({
      ok: true,
      sections: [
        { heading: "Parties", body: "Between {{business.name}}\n  and {{client.name}}." },
        { heading: "Payment", body: "- Deposit: {{payment.deposit}}\n- Balance: {{payment.balance}}" },
      ],
    });
  });

  it("accepts Windows line endings from browser textareas", () => {
    expect(parseTemplateText("## A\r\nline one\r\nline two")).toEqual({ ok: true, sections: [{ heading: "A", body: "line one\nline two" }] });
  });

  it("round-trips through the editor text", () => {
    const text = sectionsToText(DEMO_TEMPLATE_SECTIONS);
    expect(parseTemplateText(text)).toEqual({ ok: true, sections: DEMO_TEMPLATE_SECTIONS });
  });

  it("does not interpret markup: HTML stays literal text", () => {
    const parsed = parseTemplateText("## Notes\n<script>alert(1)</script> **bold**");
    expect(parsed).toEqual({ ok: true, sections: [{ heading: "Notes", body: "<script>alert(1)</script> **bold**" }] });
  });

  it.each([
    ["", /at least one section/],
    ["Some text before any heading\n## A\nx", /Start the text with a section heading/],
    ["## \nbody", /needs a heading/],
    ["## Empty\n\n   \n## Next\ntext", /"Empty" has no text/],
    [`## ${"h".repeat(201)}\nx`, /longer than 200/],
    [Array.from({ length: 61 }, (_, i) => `## S${i}\nx`).join("\n"), /at most 60 sections/],
  ])("rejects malformed structure %#", (input, error) => {
    const parsed = parseTemplateText(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });
});

describe("DEMO template", () => {
  it("is clearly marked as not for client use", () => {
    expect(DEMO_TEMPLATE_TITLE).toContain("DEMO, NOT FOR CLIENT USE");
    expect(DEMO_TEMPLATE_TEXT).toContain("DEMO, NOT FOR CLIENT USE");
    expect(DEMO_TEMPLATE_TEXT).toMatch(/not been reviewed by a lawyer/);
  });

  it("invents no legal or payment-deadline terms beyond the placeholders", () => {
    // The balance deadline only ever comes from the staff-entered placeholder.
    expect(DEMO_TEMPLATE_TEXT).toContain("due {{payment.balance_due_date}}");
    expect(DEMO_TEMPLATE_TEXT).not.toMatch(/\b\d+ days\b|non-refundable|liab(le|ility) (is|shall)|cancel(lation)? fee/i);
  });

  it("uses only well-formed placeholders", () => {
    const all = `${DEMO_TEMPLATE_TITLE}\n${DEMO_TEMPLATE_TEXT}`;
    const stripped = all.replace(/\{\{\s*[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\s*\}\}/g, "");
    expect(stripped).not.toMatch(/\{\{|\}\}/);
  });
});

describe("contract error messages", () => {
  it("explains template and generation errors from the database", () => {
    expect(describeDbError({ code: "22023", message: "contract_template_invalid: unknown placeholder {{client.nmae}}" })).toBe(
      "This template can't be used: unknown placeholder {{client.nmae}}.",
    );
    expect(
      describeDbError({ code: "22023", message: "contract_stale_approval: this approval is no longer current because a revised offer replaced it" }),
    ).toBe("A contract can't be generated: this approval is no longer current because a revised offer replaced it.");
    expect(describeDbError({ code: "22023", message: "contract_input_invalid: the balance due date is in the past" })).toMatch(/in the past/);
  });
});

describe("contract email (prepared for the sending stage)", () => {
  const input = {
    tenantDisplayName: "BOUPROD",
    legalName: "BOUPROD Legal Inc.",
    contactEmail: "legal@bouprod.test",
    clientName: "Robin <b>&</b> Kai",
    eventTitle: "Wedding",
    depositCents: 75_884,
    depositPercent: 30,
    currency: "CAD",
    signingLink: "http://127.0.0.1:3000/bouprod/c#TOKEN",
  };

  it("states the deposit, the business contact and that email verification comes before signing", async () => {
    const { renderContractEmail } = await import("@/lib/email/templates");
    const email = renderContractEmail(input);
    expect(email.subject).toBe("BOUPROD sent your contract for Wedding");
    expect(email.text).toContain("A deposit of $758.84 (30% of the total) is due on signing.");
    expect(email.text).toContain("Contact BOUPROD Legal Inc. at legal@bouprod.test.");
    expect(email.text).toContain("You will confirm your email address before you can sign.");
    expect(email.text).toContain("Review and sign: http://127.0.0.1:3000/bouprod/c#TOKEN");
  });

  it("escapes client-provided values in HTML", async () => {
    const { renderContractEmail } = await import("@/lib/email/templates");
    const { html } = renderContractEmail(input);
    expect(html).toContain("Robin &lt;b&gt;&amp;&lt;/b&gt; Kai");
    expect(html).not.toContain("<b>&</b>");
  });

  it("is not an outbox event type, so nothing can queue it yet", async () => {
    const source = (await import("node:fs")).readFileSync("src/lib/email/templates.ts", "utf8");
    const union = /export type OutboxEventType = ([^;]+);/.exec(source)![1];
    expect(union).not.toMatch(/contract/);
  });
});

describe("DEMO template business identity", () => {
  it("uses the legal identity placeholders, not the display name", () => {
    expect(DEMO_TEMPLATE_TEXT).toContain("{{business.legal_name}}, {{business.address}}, {{business.email}}");
    expect(DEMO_TEMPLATE_TEXT).not.toContain("{{business.display_name}}");
  });
});

describe("settings error messages", () => {
  it("explains invalid settings from the database", () => {
    expect(describeDbError({ code: "22023", message: "settings_invalid: the deposit must be a whole percentage from 0 to 100" })).toBe(
      "Check the settings: the deposit must be a whole percentage from 0 to 100.",
    );
  });
});
