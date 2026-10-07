import { z } from "zod";
import { eventStatusLabel } from "@/lib/events/status";
import { dateIn, shortDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";

export { dateIn, shortDate };

/**
 * The staff dashboard. public.staff_dashboard (see its migration) returns
 * facts: upcoming events and the raw attention and setup state. This module
 * decides the wording, order and links. Nothing here, and nothing in the
 * function, changes data, sets up plans, confirms bookings or sends email.
 */

const upcomingSchema = z.object({
  id: z.string(),
  title: z.string(),
  event_date: z.string(),
  timezone: z.string(),
  venue_name: z.string().nullable(),
  lifecycle_status: z.string(),
  client_name: z.string().nullable(),
  contract_signed: z.boolean(),
});

const eventRef = { event_id: z.string(), title: z.string(), event_date: z.string() };

export const dashboardSchema = z.object({
  now: z.string(),
  planning_window_days: z.number().int(),
  upcoming: z.array(upcomingSchema),
  upcoming_more: z.boolean(),
  submitted: z.array(z.object({ ...eventRef, proposal_id: z.string(), revision: z.number().int(), submitted_at: z.string().nullable() })),
  awaiting_deposit: z.array(z.object({ ...eventRef, currency: z.string(), deposit_outstanding_cents: z.number().nullable() })),
  booking_check: z.array(z.object(eventRef)),
  planning: z.array(
    z.object({
      ...eventRef,
      timezone: z.string(),
      state: z.enum(["open", "reopened", "closed"]),
      deadline: z.string(),
      closes_at: z.string().nullable(),
      requirements_met: z.number().int(),
      requirements_total: z.number().int(),
    }),
  ),
  failed_emails: z.number().int(),
  setup: z.object({
    identity_saved: z.boolean(),
    tax_categories: z.array(z.string()),
    used_tax_categories: z.array(z.string()),
    active_packages: z.number().int(),
    usable_proposal_templates: z.number().int(),
    client_use_contract_templates: z.number().int(),
  }),
});
export type DashboardFacts = z.infer<typeof dashboardSchema>;
export type UpcomingEvent = z.infer<typeof upcomingSchema>;

/** How many attention items show before "Show all". */
export const ATTENTION_SHOWN = 6;
/** How many upcoming events the dashboard lists. */
export const UPCOMING_SHOWN = 8;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const dayNumber = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** "Today", "Tomorrow", "In 5 days" or null (further out), counted in the event's own time zone. */
export function relativeDay(isoDate: string, timeZone: string, now: Date): string | null {
  const days = dayNumber(isoDate) - dayNumber(dateIn(timeZone, now));
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days <= 7) return `In ${days} days`;
  return null;
}

// ---------------------------------------------------------------------------
// Upcoming events
// ---------------------------------------------------------------------------

export type UpcomingRow = UpcomingEvent & { href: string; date: string; relative: string | null; status: string; booked: boolean; venue: string };

export function upcomingRows(facts: DashboardFacts, slug: string): UpcomingRow[] {
  const now = new Date(facts.now);
  return facts.upcoming.map((e) => ({
    ...e,
    href: `/staff/${slug}/events/${e.id}`,
    date: shortDate(e.event_date),
    relative: relativeDay(e.event_date, e.timezone, now),
    // The existing staff label (booked, awaiting deposit, check booking, lead…).
    status: eventStatusLabel(e.lifecycle_status, e.contract_signed),
    booked: e.lifecycle_status === "booked",
    venue: e.venue_name ?? "Venue not set",
  }));
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

export type AttentionKind = "proposal_submitted" | "planning_closed" | "planning_closing" | "deposit" | "booking_check";

export type AttentionItem = {
  /** One per underlying task: an event can have several different tasks, never the same one twice. */
  key: string;
  kind: AttentionKind;
  eventId: string;
  title: string;
  eventDate: string;
  reason: string;
  detail: string | null;
  href: string;
  action: string;
  /** Planning past its deadline is shown apart from deadlines still ahead. */
  tone: "urgent" | "normal";
  /** Order within a kind: when planning closes; otherwise the event date. */
  sortKey: string;
};

// Order of the list: what someone is waiting on first, then planning past and
// near its deadline (soonest first), then deposits and booking checks by date.
const ORDER: Record<AttentionKind, number> = { proposal_submitted: 0, planning_closed: 1, planning_closing: 2, deposit: 3, booking_check: 4 };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "within a day" under 24 hours, otherwise "in 3 days" (nearest whole day). */
export function closesIn(closesAt: string, now: Date): string {
  const days = (new Date(closesAt).getTime() - now.getTime()) / 86_400_000;
  return days < 1 ? "within a day" : `in ${plural(Math.round(days), "day")}`;
}

export function attentionItems(facts: DashboardFacts, slug: string): AttentionItem[] {
  const now = new Date(facts.now);
  const event = (id: string) => `/staff/${slug}/events/${id}`;
  const items: AttentionItem[] = [];

  for (const p of facts.submitted) {
    items.push({
      key: `proposal:${p.proposal_id}`,
      kind: "proposal_submitted",
      eventId: p.event_id,
      title: p.title,
      eventDate: p.event_date,
      reason: "Proposal ready to review",
      detail: `The client submitted their choices (revision ${p.revision}).`,
      href: `/staff/${slug}/proposals/${p.proposal_id}`,
      action: "Review proposal",
      tone: "normal",
      sortKey: "",
    });
  }
  for (const d of facts.awaiting_deposit) {
    items.push({
      key: `deposit:${d.event_id}`,
      kind: "deposit",
      eventId: d.event_id,
      title: d.title,
      eventDate: d.event_date,
      reason: "Signed · waiting for the deposit",
      detail: d.deposit_outstanding_cents ? `${formatCents(d.deposit_outstanding_cents, d.currency)} still to receive before the booking is confirmed.` : null,
      href: `${event(d.event_id)}#record-payment`,
      action: "Record a payment",
      tone: "normal",
      sortKey: "",
    });
  }
  for (const b of facts.booking_check) {
    items.push({
      key: `booking-check:${b.event_id}`,
      kind: "booking_check",
      eventId: b.event_id,
      title: b.title,
      eventDate: b.event_date,
      reason: "Contract signed · booking not checked yet",
      detail: "Signed before booking rules existed, so it isn't confirmed automatically.",
      href: `${event(b.event_id)}#payments`,
      action: "Check booking",
      tone: "normal",
      sortKey: "",
    });
  }
  for (const p of facts.planning) {
    const missing = p.requirements_total - p.requirements_met;
    if (missing <= 0) continue;
    const answers = `${plural(missing, "required answer")} missing`;
    const closed = p.state === "closed";
    items.push({
      key: `planning:${p.event_id}`,
      kind: closed ? "planning_closed" : "planning_closing",
      eventId: p.event_id,
      title: p.title,
      eventDate: p.event_date,
      reason: closed
        ? "Planning closed with answers missing"
        : `${p.state === "reopened" ? "Reopened planning" : "Planning"} closes ${closesIn(p.closes_at ?? p.deadline, now)}`,
      detail: closed ? `${answers}. The client can no longer edit; you still can.` : `${answers}.`,
      href: `/staff/${slug}/events/${p.event_id}/planning`,
      action: "Open planning",
      tone: closed ? "urgent" : "normal",
      sortKey: p.closes_at ?? p.deadline,
    });
  }

  const seen = new Set<string>();
  return items
    .filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
    .sort(
      (a, b) =>
        ORDER[a.kind] - ORDER[b.kind] ||
        (a.sortKey || a.eventDate).localeCompare(b.sortKey || b.eventDate) ||
        a.eventDate.localeCompare(b.eventDate) ||
        a.title.localeCompare(b.title),
    );
}

// ---------------------------------------------------------------------------
// Setup checklist
// ---------------------------------------------------------------------------

export type SetupItem = { key: string; label: string; done: boolean; href: string; hint: string; ownerOnly: boolean };

/**
 * Derived from saved data only. Gear, a logo and planning templates are
 * optional; a tax category with no taxes is a valid "no tax" choice.
 * Completing it doesn't mean a business is legally or operationally ready.
 */
export function setupChecklist(facts: DashboardFacts, slug: string): SetupItem[] {
  const s = facts.setup;
  const configured = new Set(s.tax_categories);
  const unconfigured = s.used_tax_categories.filter((c) => !configured.has(c));
  return [
    {
      key: "identity",
      label: "Legal name, address and contact email",
      done: s.identity_saved,
      href: `/staff/${slug}/settings`,
      hint: "Contracts can't be sent until they're saved.",
      ownerOnly: true,
    },
    {
      key: "taxes",
      label: "Taxes",
      done: configured.size > 0 && unconfigured.length === 0,
      href: `/staff/${slug}/settings#taxes`,
      hint:
        unconfigured.length > 0
          ? `Set taxes for ${unconfigured.join(", ")} (used by active gear or packages). "No tax" is a valid choice.`
          : 'Choose the taxes for your prices. "No tax" is a valid choice.',
      ownerOnly: true,
    },
    {
      key: "packages",
      label: "Three active packages",
      done: s.active_packages >= 3,
      href: `/staff/${slug}/packages`,
      hint: s.active_packages > 0 ? `Each proposal offers three packages; ${s.active_packages} active so far.` : "Each proposal offers three packages.",
      ownerOnly: false,
    },
    {
      key: "proposal-template",
      label: "A proposal template",
      done: s.usable_proposal_templates > 0,
      href: `/staff/${slug}/templates`,
      hint: "An active template whose three packages are all active.",
      ownerOnly: false,
    },
    {
      key: "contract-template",
      label: "A contract template published for client use",
      done: s.client_use_contract_templates > 0,
      href: `/staff/${slug}/contract-templates`,
      hint: "DEMO versions can't be sent to clients.",
      ownerOnly: true,
    },
  ];
}
