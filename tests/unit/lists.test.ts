import { describe, expect, it } from "vitest";
import { clientListHref, eventListHref, isDefaultEventList, nearDay, nextEventLabel, parseClientListParams, parseEventListParams, rangeText } from "@/lib/lists";

describe("events list parameters", () => {
  it("defaults to upcoming, any status, archived excluded", () => {
    const p = parseEventListParams({});
    expect(p).toEqual({ q: "", view: "upcoming", status: null, archived: false, page: 1 });
    expect(isDefaultEventList(p)).toBe(true);
  });
  it("reads valid values and ignores anything else", () => {
    expect(parseEventListParams({ q: "  Garcia ", view: "past", status: "booked", archived: "1", page: "3" })).toEqual({
      q: "Garcia", view: "past", status: "booked", archived: true, page: 3,
    });
    expect(parseEventListParams({ view: "soon", status: "paid", archived: "yes", page: "-2" })).toEqual({ q: "", view: "upcoming", status: null, archived: false, page: 1 });
    expect(parseEventListParams({ q: "x".repeat(300) }).q).toHaveLength(100);
    expect(parseEventListParams({ view: ["past", "all"] }).view).toBe("past");
  });
  it("keeps the earlier ?show=all link working: every date, archived included", () => {
    expect(parseEventListParams({ show: "all" })).toMatchObject({ view: "all", archived: true });
    expect(parseEventListParams({ show: "all", view: "past" })).toMatchObject({ view: "past", archived: true });
  });
  it("builds short, stable links", () => {
    expect(eventListHref("/e", parseEventListParams({}))).toBe("/e");
    expect(eventListHref("/e", { q: "a&b", view: "all", status: "lead", archived: true, page: 2 })).toBe("/e?q=a%26b&view=all&status=lead&archived=1&page=2");
  });
});

describe("clients list parameters", () => {
  it("defaults to active clients", () => {
    expect(parseClientListParams({})).toEqual({ q: "", archived: false, page: 1 });
    expect(clientListHref("/c", { q: "ana", archived: true, page: 1 })).toBe("/c?q=ana&archived=1");
  });
});

describe("list text", () => {
  it("describes the visible range", () => {
    expect(rangeText(1, 3, 3)).toBe("3 shown");
    expect(rangeText(2, 25, 61)).toBe("Showing 26–50 of 61");
  });
  it("names nearby days against the event's own today", () => {
    expect(nearDay("2026-10-07", "2026-10-07")).toBe("Today");
    expect(nearDay("2026-10-08", "2026-10-07")).toBe("Tomorrow");
    expect(nearDay("2026-10-06", "2026-10-07")).toBe("Yesterday");
    expect(nearDay("2026-11-01", "2026-10-07")).toBeNull();
  });
});

describe("next event wording", () => {
  it("labels the next event explicitly, with the list's date format", () => {
    expect(nextEventLabel({ event_date: "2027-06-12", today: "2026-10-07" })).toEqual({ label: "Next event:", date: "Sat, Jun 12, 2027" });
  });
  it("adds Today or Tomorrow only when true for the event's own calendar", () => {
    expect(nextEventLabel({ event_date: "2026-10-07", today: "2026-10-07" }).date).toBe("Wed, Oct 7, 2026 (Today)");
    expect(nextEventLabel({ event_date: "2026-10-08", today: "2026-10-07" }).date).toBe("Thu, Oct 8, 2026 (Tomorrow)");
    expect(nextEventLabel({ event_date: "2026-10-10", today: "2026-10-07" }).date).toBe("Sat, Oct 10, 2026");
    // Across a month and year boundary.
    expect(nextEventLabel({ event_date: "2027-01-01", today: "2026-12-31" }).date).toBe("Fri, Jan 1, 2027 (Tomorrow)");
  });
});
