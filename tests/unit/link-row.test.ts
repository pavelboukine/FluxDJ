import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LinkRow } from "@/components/app/link-row";

const render = (props: Parameters<typeof LinkRow>[0]) => renderToStaticMarkup(createElement(LinkRow, props));

describe("LinkRow", () => {
  it("is one link: the whole row, with its text as the name and a decorative chevron", () => {
    const html = render({ href: "/staff/dj/contracts/c1", title: "Contract", detail: "Wedding agreement v3", status: "Signed Mar 2", testId: "row" });
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html.startsWith("<a")).toBe(true);
    expect(html).toContain('href="/staff/dj/contracts/c1"');
    expect(html).toContain('data-testid="row"');
    // Nothing focusable inside the link.
    expect(html).not.toMatch(/<(button|input|select|textarea)\b|tabindex=/);
    // Text in reading order: title, detail, status; the chevron is hidden from assistive technology.
    const text = html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "|").split("|").filter(Boolean);
    expect(text).toEqual(["Contract", "Wedding agreement v3", "Signed Mar 2"]);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("has a 44px minimum height, hover, pressed and visible focus states", () => {
    const cls = render({ href: "#payments", title: "Payments" }).match(/^<a[^>]*class="([^"]+)"/)![1].split(" ");
    expect(cls).toEqual(expect.arrayContaining(["min-h-11", "hover:bg-muted/50", "active:bg-muted", "focus-visible:ring-3", "outline-none"]));
  });

  it("leaves out empty supporting text and status", () => {
    const html = render({ href: "#payments", title: "Payments", detail: null, status: "" });
    expect(html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "")).toBe("Payments");
  });
});
