import { describe, expect, it } from "vitest";
import { targetedId, watchHashTargets, type HashWindow } from "@/components/app/hash-targets";

/** A stand-in window: listeners by type, an address, and a document receiving clicks. */
function fakeWindow(href: string) {
  const listeners = (): Map<string, Set<(e: Event) => void>> => new Map();
  const on = listeners();
  const docOn = listeners();
  const add = (m: Map<string, Set<(e: Event) => void>>) => (type: string, fn: (e: Event) => void) => void (m.get(type) ?? m.set(type, new Set()).get(type)!).add(fn);
  const remove = (m: Map<string, Set<(e: Event) => void>>) => (type: string, fn: (e: Event) => void) => void m.get(type)?.delete(fn);
  const url = new URL(href);
  const win: HashWindow & { go: (next: string, event: "hashchange" | "popstate") => void; click: (linkHref: string | null) => void; count: () => number } = {
    location: { get hash() { return url.hash; }, get href() { return url.href; }, get pathname() { return url.pathname; } },
    addEventListener: add(on),
    removeEventListener: remove(on),
    document: { addEventListener: add(docOn), removeEventListener: remove(docOn) },
    go(next, event) {
      url.href = new URL(next, url).href;
      for (const fn of on.get(event) ?? []) fn(new Event(event));
    },
    click(linkHref) {
      const link = linkHref === null ? null : (() => { const u = new URL(linkHref, url); return { href: u.href, pathname: u.pathname }; })();
      // A click on text inside the link: closest("a[href]") finds the link.
      const target = { closest: (selector: string) => (selector === "a[href]" ? link : null) };
      for (const fn of docOn.get("click") ?? []) fn({ target } as unknown as Event);
    },
    count: () => [...on.values(), ...docOn.values()].reduce((n, s) => n + s.size, 0),
  };
  return win;
}

const PAGE = "https://fluxdj.test/staff/dj/events/ev";

describe("targetedId", () => {
  it("matches the section's own id and its targets, decoded", () => {
    expect(targetedId("#payments", ["payments", "record-payment"])).toBe("payments");
    expect(targetedId("#record-payment", ["payments", "record-payment"])).toBe("record-payment");
    expect(targetedId("#caf%C3%A9", ["café"])).toBe("café");
  });

  it("ignores no hash, an empty hash, other ids and malformed escapes it doesn't hold", () => {
    expect(targetedId("", ["payments"])).toBeNull();
    expect(targetedId("#", ["payments"])).toBeNull();
    expect(targetedId("#planning", ["payments"])).toBeNull();
    expect(targetedId("payments", ["payments"])).toBeNull();
    expect(targetedId("#%E0%A4%A", ["payments"])).toBeNull();
    expect(targetedId("#%E0%A4%A", ["%E0%A4%A"])).toBe("%E0%A4%A");
  });
});

describe("watchHashTargets", () => {
  const IDS = ["communications", "proposal-history", "contract-history"];

  it("reports a target on load", () => {
    const win = fakeWindow(`${PAGE}#proposal-history`);
    const seen: string[] = [];
    watchHashTargets(win, IDS, (id, source) => seen.push(`${id}:${source}`));
    expect(seen).toEqual(["proposal-history:address"]);
  });

  it("reports nothing on load without a matching hash", () => {
    const seen: string[] = [];
    watchHashTargets(fakeWindow(`${PAGE}#payments`), IDS, (id) => seen.push(id));
    watchHashTargets(fakeWindow(PAGE), IDS, (id) => seen.push(id));
    expect(seen).toEqual([]);
  });

  it("reports hash changes and back/forward, and only matching ones", () => {
    const win = fakeWindow(PAGE);
    const seen: string[] = [];
    watchHashTargets(win, IDS, (id) => seen.push(id));
    win.go("#communications", "hashchange");
    win.go("#payments", "hashchange");
    win.go("#contract-history", "hashchange");
    // Back to #communications: popstate (a client-side router's entries) still opens it.
    win.go("#communications", "popstate");
    win.go("", "popstate");
    expect(seen).toEqual(["communications", "contract-history", "communications"]);
  });

  it("reports a click on a link to a target on this page, even when the address already points there", () => {
    const win = fakeWindow(`${PAGE}#communications`);
    const seen: string[] = [];
    watchHashTargets(win, IDS, (id, source) => seen.push(`${id}:${source}`));
    win.click("#communications");
    win.click(`${PAGE}#contract-history`);
    expect(seen).toEqual(["communications:address", "communications:click", "contract-history:click"]);
  });

  it("ignores clicks elsewhere: no link, another page, another id", () => {
    const win = fakeWindow(PAGE);
    const seen: string[] = [];
    watchHashTargets(win, IDS, (id) => seen.push(id));
    win.click(null);
    win.click("/staff/dj/events/other#communications");
    win.click("#payments");
    win.click("/staff/dj/proposals/p1");
    expect(seen).toEqual([]);
  });

  it("removes every listener on cleanup", () => {
    const win = fakeWindow(PAGE);
    const seen: string[] = [];
    const stop = watchHashTargets(win, IDS, (id) => seen.push(id));
    expect(win.count()).toBe(3);
    stop();
    expect(win.count()).toBe(0);
    win.go("#communications", "hashchange");
    win.click("#communications");
    expect(seen).toEqual([]);
  });

  it("a section without targets answers to its own id only (Disclosure's existing behaviour)", () => {
    const win = fakeWindow(`${PAGE}#record-payment`);
    const seen: string[] = [];
    watchHashTargets(win, ["record-payment"], (id, source) => seen.push(`${id}:${source}`));
    win.go("#payments", "hashchange");
    win.click("#record-payment");
    expect(seen).toEqual(["record-payment:address", "record-payment:click"]);
  });
});
