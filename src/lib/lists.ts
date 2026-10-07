import { z } from "zod";
import { shortDate } from "@/lib/dates";

/**
 * The staff Events and Clients lists keep their search, filters and page in
 * the URL (so refresh, Back and returning from a record behave predictably).
 * Parameters are validated here and again by the database functions
 * (staff_event_list, staff_client_list); anything unknown falls back to the
 * default instead of failing.
 */

export const PAGE_SIZE = 25;
export const SEARCH_MAX = 100;

export const EVENT_VIEWS = [
  ["upcoming", "Upcoming"],
  ["past", "Past"],
  ["all", "All dates"],
] as const;
export type EventView = (typeof EVENT_VIEWS)[number][0];

/** Lifecycle filters, labelled like the existing status badges. */
export const EVENT_STATUSES = [
  ["lead", "Lead"],
  ["pending_approval", "Pending approval"],
  ["awaiting_signature", "Awaiting signature"],
  ["awaiting_deposit", "Signed · awaiting deposit"],
  ["booked", "Booked"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number][0];

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function search(v: string | string[] | undefined): string {
  return (one(v) ?? "").trim().slice(0, SEARCH_MAX);
}
function page(v: string | string[] | undefined): number {
  const n = Number(one(v));
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

export type EventListParams = { q: string; view: EventView; status: EventStatus | null; archived: boolean; page: number };

/** Defaults: upcoming, any status, archived excluded. `?show=all` (the earlier "Include archived" link) still lists everything. */
export function parseEventListParams(sp: Params): EventListParams {
  const legacyAll = one(sp.show) === "all";
  const view = EVENT_VIEWS.find(([v]) => v === one(sp.view))?.[0] ?? (legacyAll ? "all" : "upcoming");
  const status = EVENT_STATUSES.find(([s]) => s === one(sp.status))?.[0] ?? null;
  return { q: search(sp.q), view, status, archived: one(sp.archived) === "1" || legacyAll, page: page(sp.page) };
}

export type ClientListParams = { q: string; archived: boolean; page: number };

/** Defaults: active clients only. */
export function parseClientListParams(sp: Params): ClientListParams {
  return { q: search(sp.q), archived: one(sp.archived) === "1", page: page(sp.page) };
}

/** A list URL with only non-default parameters, so links stay short and stable. */
export function eventListHref(base: string, p: Partial<EventListParams>): string {
  const s = new URLSearchParams();
  if (p.q) s.set("q", p.q);
  if (p.view && p.view !== "upcoming") s.set("view", p.view);
  if (p.status) s.set("status", p.status);
  if (p.archived) s.set("archived", "1");
  if (p.page && p.page > 1) s.set("page", String(p.page));
  const qs = s.toString();
  return qs ? `${base}?${qs}` : base;
}

export function clientListHref(base: string, p: Partial<ClientListParams>): string {
  const s = new URLSearchParams();
  if (p.q) s.set("q", p.q);
  if (p.archived) s.set("archived", "1");
  if (p.page && p.page > 1) s.set("page", String(p.page));
  const qs = s.toString();
  return qs ? `${base}?${qs}` : base;
}

export const isDefaultEventList = (p: EventListParams) => !p.q && p.view === "upcoming" && !p.status && !p.archived;
export const isDefaultClientList = (p: ClientListParams) => !p.q && !p.archived;

const counts = { total: z.number().int(), archived_excluded: z.number().int() };

export const eventListSchema = z.object({
  ...counts,
  tenant_events: z.number().int(),
  rows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      event_date: z.string(),
      timezone: z.string(),
      venue_name: z.string().nullable(),
      lifecycle_status: z.string(),
      archived: z.boolean(),
      client_name: z.string().nullable(),
      today: z.string(),
      contract_signed: z.boolean(),
    }),
  ),
});
export type EventList = z.infer<typeof eventListSchema>;

export const clientListSchema = z.object({
  ...counts,
  tenant_clients: z.number().int(),
  rows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      phone: z.string().nullable(),
      archived: z.boolean(),
      events: z.number().int(),
      next_event: z.object({ id: z.string(), title: z.string(), event_date: z.string(), today: z.string() }).nullable(),
    }),
  ),
});
export type ClientList = z.infer<typeof clientListSchema>;

/** "Showing 26–50 of 61". */
export function rangeText(pageNumber: number, shown: number, total: number): string {
  if (total === 0) return "";
  const from = (pageNumber - 1) * PAGE_SIZE + 1;
  return shown === total ? `${total} shown` : `Showing ${from}–${from + shown - 1} of ${total}`;
}

/** "Today", "Tomorrow", "Yesterday" for a calendar date, against the event's own today. */
export function nearDay(eventDate: string, today: string): string | null {
  const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;
  const diff = day(eventDate) - day(today);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : null;
}

/**
 * A client's next event as "Next event: Sat, Jun 12, 2027 (Tomorrow)": an
 * explicit label, the same calendar-date format as the Events list, and
 * Today/Tomorrow only when that's true in the event's own time zone (never
 * "next Saturday" for a distant date).
 */
export function nextEventLabel(next: { event_date: string; today: string }): { label: string; date: string } {
  const near = nearDay(next.event_date, next.today);
  return { label: "Next event:", date: `${shortDate(next.event_date)}${near && near !== "Yesterday" ? ` (${near})` : ""}` };
}

/**
 * A client's role on one event (roles belong to the event's contact link,
 * not to the client): primary contact, signer, both, or another contact.
 */
export function contactRoleLabel(link: { is_primary: boolean; can_sign: boolean }): string {
  if (link.is_primary && link.can_sign) return "Primary contact · Signer";
  if (link.is_primary) return "Primary contact";
  if (link.can_sign) return "Signer";
  return "Other contact";
}

/**
 * The UTC calendar date `days` from `at`. Every time zone's "today" is within
 * a day of UTC's, so [UTC today − 1, UTC today + 1] bounds a query that the
 * exact event-local split (isUpcomingEvent) then refines.
 */
export function utcDateFrom(at: Date, days: number): string {
  return new Date(at.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Upcoming means not archived and dated today or later in the event's own time zone. */
export function isUpcomingEvent(e: { event_date: string; archived: boolean }, eventToday: string): boolean {
  return !e.archived && e.event_date >= eventToday;
}

export type GearListParams = { q: string; archived: boolean; page: number };

/** Defaults: active gear only. `?show=archived` (the earlier "Show archived" link) includes archived items. */
export function parseGearListParams(sp: Params): GearListParams {
  return { q: search(sp.q), archived: one(sp.archived) === "1" || one(sp.show) === "archived", page: page(sp.page) };
}

export function gearListHref(base: string, p: Partial<GearListParams>): string {
  return clientListHref(base, p);
}

export const isDefaultGearList = (p: GearListParams) => !p.q && !p.archived;

/**
 * A PostgREST `or` filter matching rows where any column contains `q`, case
 * insensitive. LIKE wildcards in the search are escaped (literal % and _) and
 * the value is quoted, so commas, dots and parentheses are plain text.
 */
export function containsFilter(columns: readonly string[], q: string): string {
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const quoted = `"${pattern.replace(/["\\]/g, "\\$&")}"`;
  return columns.map((c) => `${c}.ilike.${quoted}`).join(",");
}
