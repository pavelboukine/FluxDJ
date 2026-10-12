import { describe, expect, it } from "vitest";
import { checkClientPhone, telHref } from "@/lib/phone";

const ok = (raw: string) => checkClientPhone(raw);

describe("client phone numbers", () => {
  it("is optional: blank means no number", () => {
    expect(ok("")).toEqual({ ok: true, value: null });
    expect(ok("   ")).toEqual({ ok: true, value: null });
    expect(checkClientPhone(null)).toEqual({ ok: true, value: null });
  });

  it("accepts Canadian numbers as people write them, keeping what was typed", () => {
    for (const n of ["514 555-0100", "(514) 555-0100", "514.555.0100", "5145550100", "+1 514-555-0100", "1-800-555-0199", "(+1) 514 555 0100"]) {
      expect(ok(n), n).toEqual({ ok: true, value: n });
    }
  });

  it("accepts international numbers and keeps their country code", () => {
    for (const n of ["+33 1 23 45 67 89", "+44 (0)20 7946 0958", "+61 2 9876 5432", "+81 3-1234-5678", "0033 1 23 45 67 89", "+52 55 1234 5678"]) {
      expect(ok(n), n).toEqual({ ok: true, value: n });
    }
  });

  it("accepts an extension", () => {
    for (const n of ["514 555-0100 ext. 12", "514 555-0100 x12", "+1 514 555 0100 #1234", "514-555-0100 extension 7"]) {
      expect(ok(n).ok, n).toBe(true);
    }
  });

  it("only trims and collapses spaces; never reformats", () => {
    expect(ok("  +1   514  555-0100 ")).toEqual({ ok: true, value: "+1 514 555-0100" });
  });

  it("explains what's wrong", () => {
    expect(ok("call me")).toMatchObject({ ok: false, message: expect.stringMatching(/digits/) });
    expect(ok("514 555")).toMatchObject({ ok: false, message: expect.stringMatching(/7 to 20 digits/) });
    expect(ok("+1 +514 555 0100")).toMatchObject({ ok: false });
    expect(ok("514 + 555 0100")).toMatchObject({ ok: false });
    expect(ok("(514 555-0100")).toMatchObject({ ok: false, message: expect.stringMatching(/brackets/) });
    expect(ok("1".repeat(41))).toMatchObject({ ok: false, message: expect.stringMatching(/too long/) });
    expect(ok("1".repeat(21))).toMatchObject({ ok: false, message: expect.stringMatching(/7 to 20 digits/) });
  });

  it("dials the number without its punctuation or extension", () => {
    expect(telHref("+1 (514) 555-0100 ext. 12")).toBe("tel:+15145550100");
    expect(telHref("+44 (0)20 7946 0958")).toBe("tel:+4402079460958");
    expect(telHref("514.555.0100")).toBe("tel:5145550100");
    expect(telHref(null)).toBeNull();
    expect(telHref("no number")).toBeNull();
  });
});
