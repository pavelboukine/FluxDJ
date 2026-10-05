import { describe, expect, it } from "vitest";
import { isHttpsUrl, linkHost, todayIn } from "@/lib/payments";
import { parseMoneyToCents } from "@/lib/money";

describe("payments helpers", () => {
  it("accepts only absolute https addresses with a host name and no credentials", () => {
    for (const ok of ["https://invoice.example.com/i/42", "https://pay.waveapps.com/invoices/abc?x=1#top", "https://a.b.co:8443/x"]) {
      expect(isHttpsUrl(ok)).toBe(true);
    }
    for (const bad of [
      "http://invoice.example.com/", "javascript:alert(1)", "https://user:pw@example.com/", "https://localhost/x", "//example.com/x",
      "https://example.com/ space", "https://a.example.com/\"><script>", "HTTPS://", "data:text/html,hi", `https://example.com/${"x".repeat(2000)}`,
    ]) {
      expect(isHttpsUrl(bad)).toBe(false);
    }
    expect(linkHost("https://pay.example.com/i/1")).toBe("pay.example.com");
  });

  it("parses amounts to exact cents and gives today's date in a time zone", () => {
    expect(parseMoneyToCents("0.01")).toBe(1);
    expect(parseMoneyToCents("1,250.5")).toBe(125050);
    expect(parseMoneyToCents("-5")).toBeNull();
    expect(todayIn("America/Toronto")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
