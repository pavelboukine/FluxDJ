import { describe, expect, it } from "vitest";
import { formSnapshot } from "@/components/app/form-snapshot";

/** A form's entries as the browser builds them: an untouched file field is an empty, unnamed file. */
const EMPTY_FILE = new File([], "", { type: "application/octet-stream" });
const file = (name: string, bytes: string) => new File([bytes], name, { type: "image/png" });
type Entry = [string, FormDataEntryValue];
const snap = (...entries: Entry[]) => formSnapshot(entries);

describe("unsaved-change snapshot (ActionForm)", () => {
  const base: Entry[] = [["draft_version", "3"], ["primary_color", "#111827"], ["logo", EMPTY_FILE]];

  it("an untouched file field is not an edit, even when it appears or goes away", () => {
    expect(snap(...base, ["logo_on_dark", EMPTY_FILE])).toBe(snap(...base));
    expect(snap(["logo", EMPTY_FILE])).toBe(snap());
  });

  it("choosing, replacing or clearing a chosen file is a change", () => {
    const chosen = snap(...base.slice(0, 2), ["logo", file("a.png", "aaaa")]);
    expect(chosen).not.toBe(snap(...base));
    expect(snap(...base.slice(0, 2), ["logo", file("b.png", "aaaa")])).not.toBe(chosen); // another file
    expect(snap(...base.slice(0, 2), ["logo", file("a.png", "aaaaaa")])).not.toBe(chosen); // same name, other content
    expect(snap(...base)).not.toBe(chosen); // cleared again: back to the saved state, unlike the chosen one
  });

  it("an explicit removal (a checked box) is a change", () => {
    expect(snap(...base, ["remove_logo", "on"])).not.toBe(snap(...base));
  });

  it("emptying or changing a text or select value is a change", () => {
    expect(snap(["draft_version", "3"], ["primary_color", ""], ["logo", EMPTY_FILE])).not.toBe(snap(...base));
    expect(snap(["timezone", "America/Toronto"])).not.toBe(snap(["timezone", "America/Vancouver"]));
    expect(snap(["timezone", ""])).not.toBe(snap());
  });

  it("ignores the optimistic version only", () => {
    expect(snap(["draft_version", "4"], ...base.slice(1))).toBe(snap(...base));
    expect(snap(["version", "4"])).not.toBe(snap(["version", "3"]));
  });
});
