import { describe, expect, it } from "vitest";
import { checkReason, clientDeadlinePassedText, zoneName, clientDeadlinePhrase, clientEditingText, formatInstant, localInputValue, parseLocalInput, staffEditingSchema, staffEditingText } from "@/lib/planning/cutoff";
import { clientPlanningViewSchema, saveResultSchema } from "@/lib/planning/view";

describe("planning deadline display", () => {
  it("shows the instant in the event's time zone, with its abbreviation and name", () => {
    // 00:00 EDT on October 16, 2026 is 04:00 UTC.
    const text = formatInstant("2026-10-16T04:00:00+00:00", "America/Toronto");
    expect(text).toContain("October 16, 2026");
    expect(text).toMatch(/12:00\sa\.m\./);
    expect(text).toContain("EDT");
    expect(text).toContain("(America/Toronto)");
  });

  it("follows daylight saving: the same UTC hour reads differently in winter", () => {
    expect(formatInstant("2026-11-16T05:00:00+00:00", "America/Toronto")).toMatch(/12:00\sa\.m\. EST/);
    expect(formatInstant("2026-10-16T04:00:00+00:00", "Europe/Paris")).toMatch(/6:00\sa\.m\./);
  });

  it("gives datetime-local values in the event's zone, not the server's", () => {
    expect(localInputValue("2026-10-16T04:00:00Z", "America/Toronto")).toBe("2026-10-16T00:00");
    expect(localInputValue("2026-10-16T04:00:00Z", "America/Vancouver")).toBe("2026-10-15T21:00");
    expect(localInputValue("2026-10-16T22:30:00Z", "Asia/Kathmandu")).toBe("2026-10-17T04:15");
  });

  it("accepts only real wall-clock times from the reopening field", () => {
    expect(parseLocalInput("2026-10-20T18:30")).toBe("2026-10-20T18:30:00");
    expect(parseLocalInput("2026-10-20T18:30:15")).toBe("2026-10-20T18:30:00");
    expect(parseLocalInput("2026-02-30T10:00")).toBeNull();
    expect(parseLocalInput("2026-10-20T24:00")).toBeNull();
    expect(parseLocalInput("2026-10-20 18:30")).toBeNull();
    expect(parseLocalInput("2026-10-20T18:30Z")).toBeNull();
    expect(parseLocalInput("")).toBeNull();
  });

  it("requires a reason within the database's limit", () => {
    expect(checkReason("  ")).toMatch(/Enter a reason/);
    expect(checkReason("x".repeat(501))).toMatch(/under 500/);
    expect(checkReason("Guest count changed")).toBeNull();
  });

  it("tells the client exactly when editing closes, and the read-only wording after", () => {
    const base = { deadline: "2026-10-16T04:00:00+00:00", timezone: "America/Toronto" };
    // Midnight starting Friday, October 16 closes at the end of Thursday.
    expect(clientEditingText({ ...base, state: "open", closes_at: base.deadline }, "BOUPROD")).toBe(
      "You can make changes through Thursday, October 15. After that, planning becomes read-only; contact BOUPROD for changes.",
    );
    expect(clientEditingText({ ...base, state: "reopened", closes_at: "2026-10-20T22:00:00+00:00" }, "BOUPROD")).toMatch(
      /^BOUPROD reopened planning for you\. You can make changes until Tuesday, October 20 at 6:00\sp\.m\. EDT\.$/,
    );
    expect(clientEditingText({ ...base, state: "closed", closes_at: null }, "BOUPROD")).toBe("Planning is read-only. Contact your DJ for changes.");
  });

  it("says a midnight deadline as the end of the day before, in the event's zone and season", () => {
    // 00:00 EDT, July 31, 2027 (summer).
    expect(clientDeadlinePhrase("2027-07-31T04:00:00Z", "America/Toronto")).toBe("through Friday, July 30");
    // 00:00 EST, November 16, 2026 (winter): the same local midnight is a different UTC hour.
    expect(clientDeadlinePhrase("2026-11-16T05:00:00Z", "America/Toronto")).toBe("through Sunday, November 15");
    // Across a month and a year.
    expect(clientDeadlinePhrase("2026-03-01T08:00:00Z", "America/Vancouver")).toBe("through Saturday, February 28");
    expect(clientDeadlinePhrase("2027-01-01T05:00:00Z", "America/Toronto")).toBe("through Thursday, December 31");
    // East of UTC: midnight in Paris is the evening before in UTC.
    expect(clientDeadlinePhrase("2027-06-14T22:00:00Z", "Europe/Paris")).toBe("through Monday, June 14");
    // Where daylight saving skips midnight, the day's first moment (01:00) still closes the day before.
    expect(clientDeadlinePhrase("2026-09-06T04:00:00Z", "America/Santiago")).toBe("through Saturday, September 5");
  });

  it("keeps the time for any other deadline, with a readable zone and never its identifier", () => {
    expect(clientDeadlinePhrase("2026-10-20T22:00:00Z", "America/Toronto")).toMatch(/^until Tuesday, October 20 at 6:00\sp\.m\. EDT$/);
    expect(clientDeadlinePhrase("2026-12-01T17:30:00Z", "America/Toronto")).toMatch(/^until Tuesday, December 1 at 12:30\sp\.m\. EST$/);
    // The same instant, 00:00 in Toronto, is 9:00 p.m. the day before in Vancouver: not a midnight there.
    expect(clientDeadlinePhrase("2027-07-31T04:00:00Z", "America/Vancouver")).toMatch(/^until Friday, July 30 at 9:00\sp\.m\. PDT$/);
    for (const [iso, zone] of [["2027-07-31T04:00:00Z", "America/Toronto"], ["2026-10-20T22:00:00Z", "America/Toronto"]]) {
      expect(clientEditingText({ state: "open", deadline: iso, closes_at: iso, timezone: zone }, "BOUPROD")).not.toContain("America/");
    }
  });

  it("names a time zone the way people say it", () => {
    expect(zoneName("America/Toronto")).toBe("Eastern Time");
    expect(zoneName("America/Vancouver")).toBe("Pacific Time");
    expect(zoneName("Not/A_Zone")).toBe("A Zone time");
  });

  it("says when planning closed, in the same words", () => {
    expect(clientDeadlinePassedText("2027-07-31T04:00:00Z", "America/Toronto")).toBe("Planning closed at the end of Friday, July 30.");
    expect(clientDeadlinePassedText("2026-10-20T22:00:00Z", "America/Toronto")).toMatch(/^Planning closed on Tuesday, October 20 at 6:00\sp\.m\. EDT\.$/);
  });
});

describe("planning deadline shapes", () => {
  it("parses a locked save without treating it as saved", () => {
    const r = saveResultSchema.parse({ status: "locked", editing: { state: "closed", deadline: "2026-10-16T04:00:00+00:00", closes_at: null, timezone: "America/Toronto" } });
    expect(r.status).toBe("locked");
  });

  it("strips anything beyond the client-safe editing fields", () => {
    const view = clientPlanningViewSchema.parse({
      state: "available",
      brand: { display_name: "DJ", brand_colors: {} },
      event: { id: "e", title: "t", event_type: "wedding", event_date: "2026-10-30", timezone: "America/Toronto", venue_name: null, venue_address: null },
      editing: { state: "open", deadline: "2026-10-16T04:00:00+00:00", closes_at: "2026-10-16T04:00:00+00:00", timezone: "America/Toronto", reason: "secret" },
      structure: { general: [], stages: [] },
      basics: { item_id: "b", answers: {}, revision: 0 },
      stage_details: {},
      timeline_warnings: [],
      imported: null,
      progress: { scope: "available_sections_only", items: [], requirements_total: 0, requirements_met: 0, percent: null, available_sections: 0, complete_sections: 0, unavailable_sections: 0 },
    });
    expect(view.state === "available" && view.editing).toEqual({
      state: "open", deadline: "2026-10-16T04:00:00+00:00", closes_at: "2026-10-16T04:00:00+00:00", closed_by_dj: false, timezone: "America/Toronto",
    });
  });

  it("tells staff why the client can or can't edit: deadline, reopening, manual close", () => {
    const staff = (over: Record<string, unknown>) => staffEditingSchema.parse({
      state: "open", deadline: "2026-10-16T04:00:00+00:00", closes_at: "2026-10-16T04:00:00+00:00", timezone: "America/Toronto",
      now: "2026-10-01T12:00:00+00:00", cutoff_days: 14, business_days: 14, expected_deadline: "2026-10-16T04:00:00+00:00",
      schedule_changed: false, reopened_until: null, reopen_active: false, reopen_max_days: 14, version: 1, history: [], ...over,
    });
    expect(staffEditingText(staff({}))).toEqual({ title: "Client editing open", detail: expect.stringMatching(/^Open until the normal deadline, Friday, October 16, 2026/) });
    expect(staffEditingText(staff({ state: "reopened", closes_at: "2026-10-20T22:00:00+00:00" })).detail).toMatch(/^Reopened by staff until Tuesday, October 20, 2026/);
    // A manual close wins over a deadline still to come.
    const closed = staff({ state: "closed", closes_at: null, closed_by_dj: true, closed_at: "2026-10-02T15:00:00+00:00" });
    expect(staffEditingText(closed)).toEqual({ title: "Client editing closed", detail: expect.stringMatching(/^Closed by staff on Friday, October 2, 2026 .* whatever the deadline\.$/) });
    expect(staffEditingText(staff({ state: "closed", closes_at: null })).detail).toMatch(/^The deadline passed on Friday, October 16, 2026/);
    // Older databases omit the manual close.
    expect(staff({}).closed_at).toBeNull();
  });

  it("keeps working with a database that predates the cutoff (no editing field)", () => {
    const view = clientPlanningViewSchema.parse({
      state: "available",
      brand: { display_name: "DJ", brand_colors: {} },
      event: { id: "e", title: "t", event_type: "wedding", event_date: "2026-10-30", timezone: "America/Toronto", venue_name: null, venue_address: null },
      structure: { general: [], stages: [] },
      basics: { item_id: "b", answers: {}, revision: 0 },
      stage_details: {},
      timeline_warnings: [],
      imported: null,
      progress: { scope: "available_sections_only", items: [], requirements_total: 0, requirements_met: 0, percent: null, available_sections: 0, complete_sections: 0, unavailable_sections: 0 },
    });
    expect(view.state === "available" && view.editing).toBeNull();
  });

  it("reads the staff state with history", () => {
    const parsed = staffEditingSchema.parse({
      state: "reopened", deadline: "2026-10-16T04:00:00+00:00", closes_at: "2026-10-20T22:00:00+00:00", timezone: "America/Toronto",
      now: "2026-10-17T12:00:00+00:00", cutoff_days: 14, business_days: 14, expected_deadline: "2026-10-16T04:00:00+00:00", schedule_changed: false,
      reopened_until: "2026-10-20T22:00:00+00:00", reopen_active: true, reopen_max_days: 14, version: 2,
      history: [{ action: "planning_client_reopened", at: "2026-10-17T12:00:00+00:00", actor: "owner@example.test", reason: "Guest count", before: { reopened_until: null }, after: { reopened_until: "2026-10-20T22:00:00+00:00" } }],
    });
    expect(parsed.history[0].reason).toBe("Guest count");
  });
});
