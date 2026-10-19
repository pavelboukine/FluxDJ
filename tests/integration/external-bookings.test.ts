/**
 * Events booked outside Flux DJ against the LOCAL stack, with real Supabase
 * Auth, the real staff session (RLS) and the real outbox worker: staff create
 * the event and set planning up with no proposal, contract or payment; the
 * planning invitation email rebuilds its link from the invitation id; the
 * client verifies their email, accepts, plans and saves; staff get the web
 * and PDF run sheet. The booking source can't be changed, the event never
 * looks booked by Flux, and a normal Flux event still needs its booking.
 * Dedicated it- tenants, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { describeDbError } from "@/lib/db-errors";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { planningInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { loadRunSheet } from "@/lib/run-sheet/load.server";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { adminClient, archiveTestTenants, createTenantWithCatalog, localStatus, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { id: `rec-${this.messages.length}` };
  }
}

const run = randomUUID().slice(0, 8);
const clientEmail = `it-external-client-${run}@example.test`;
let admin: Db;
let owner: Db;
let otherOwner: Db;
let catalog: Catalog;
let other: Catalog;
let eventId = "";
let clientId = "";

const deliver = (transport: EmailTransport) => processOutbox({ transport, tenantId: catalog.tenantId });
const linkIn = (m: EmailMessage, pattern: RegExp) => pattern.exec(m.text)?.[1] ?? null;
const freshClient = () => {
  const env = localStatus();
  return createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
};

async function invite() {
  const id = randomUUID();
  const { data } = await must(owner.rpc("send_planning_invitation", { p_event_id: eventId, p_invitation_id: id, p_token_hash: sha256Hex(planningInviteToken(id)) }));
  expect(data).toMatchObject({ status: "sent", recipient_email: clientEmail });
  return id;
}

beforeAll(async () => {
  admin = adminClient();
  const me = await signedInUser(admin, `it-external-owner-${run}@example.test`);
  owner = me.db;
  catalog = await createTenantWithCatalog(admin, me.id, "it-external");
  const o = await signedInUser(admin, `it-external-other-${run}@example.test`);
  otherOwner = o.db;
  other = await createTenantWithCatalog(admin, o.id, "it-external-other");
});

afterAll(async () => {
  await archiveTestTenants(admin, catalog?.tenantId, other?.tenantId);
});

describe("events booked elsewhere (local Supabase)", () => {
  it("staff create one through the normal staff insert, with nothing Flux-booked pretended", async () => {
    const { data: client } = await must(owner.from("clients").insert({ tenant_id: catalog.tenantId, name: "Riya External", email: clientEmail }).select("id").single());
    clientId = client!.id;
    const { data: event } = await must(
      owner.from("events").insert({ tenant_id: catalog.tenantId, title: "IT external wedding", event_type: "wedding", event_date: "2027-06-12", booking_source: "external" }).select("id").single(),
    );
    eventId = event!.id;
    await must(owner.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));

    const { data: row } = await must(admin.from("events").select("booking_source, lifecycle_status, booking_confirmed_at, active_proposal_id").eq("id", eventId).single());
    expect(row).toEqual({ booking_source: "external", lifecycle_status: "lead", booking_confirmed_at: null, active_proposal_id: null });

    // The source is durable: staff can't change it, and no proposal can be started.
    const changed = await owner.from("events").update({ booking_source: "flux" } as never).eq("id", eventId).select("id");
    expect(changed.error?.code).toBe("42501");
    const proposal = await owner.rpc("open_proposal_draft", { p_event_id: eventId });
    expect(proposal.error?.message).toMatch(/external_booking/);
    // Another business can't read or create in this one.
    expect((await otherOwner.from("events").select("id").eq("id", eventId)).data).toEqual([]);
    const foreign = await otherOwner.from("events").insert({ tenant_id: catalog.tenantId, title: "x", event_type: "wedding", event_date: "2027-06-12", booking_source: "external" });
    expect(foreign.error?.code).toBe("42501");
  });

  it("planning is set up from a template, then the client is invited, verifies, accepts and plans", async () => {
    await must(owner.rpc("install_starter_planning_templates", { p_tenant_id: catalog.tenantId }));
    const { data: template } = await must(admin.from("planning_templates").select("id").eq("tenant_id", catalog.tenantId).eq("starter_key", "wedding").single());
    const { data: setup } = await must(owner.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
    expect(setup).toMatchObject({ status: "created" });

    const invitationId = await invite();
    const mail = new RecordingTransport();
    expect(await deliver(mail)).toMatchObject({ sent: 1 });
    const invitation = mail.messages[0];
    expect(invitation.to).toBe(clientEmail);
    expect(invitation.subject).toBe("It's time to plan your event!");
    expect(invitation.idempotencyKey).toMatch(/^flux-planning-invite-/);
    expect(invitation.text).toContain("We're ready to start planning your event!");
    expect(invitation.text).toContain("IT external wedding");
    expect(invitation.text).not.toMatch(/proposal|contract|deposit|payment/i);
    const link = new URL(linkIn(invitation, /(https?:\/\/\S+\/planning-invite#\S+)/)!);
    expect(link.pathname).toBe(`/${catalog.slug}/planning-invite`);
    const token = link.hash.slice(1);
    expect(token).toBe(planningInviteToken(invitationId));
    const { data: rows } = await must(admin.from("email_outbox").select("payload, last_error").eq("entity_id", invitationId));
    expect(JSON.stringify(rows)).not.toContain(token);

    // The token only asks for a verification email to the invited address.
    const { data: requested } = await must(admin.rpc("request_planning_sign_in", { p_token_hash: sha256Hex(token), p_tenant_slug: catalog.slug }));
    expect(requested).toMatchObject({ status: "ok" });
    const verifyMail = new RecordingTransport();
    await deliver(verifyMail);
    const message = verifyMail.messages.find((m) => m.subject.startsWith("Confirm your email to plan your event"))!;
    expect(message.to).toBe(clientEmail);
    const confirm = new URL(linkIn(message, /(https?:\/\/\S+\/auth\/confirm\?\S+)/)!);
    expect(confirm.searchParams.get("next")).toBe(`/${catalog.slug}/planning-invitations/${invitationId}`);
    const db = freshClient();
    await must(db.auth.verifyOtp({ token_hash: confirm.searchParams.get("token_hash")!, type: confirm.searchParams.get("type") as "invite" | "email" }));

    expect((await db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug })).data).toMatchObject({ state: "unavailable" });
    expect((await db.rpc("client_planning_invitation_status", { p_invitation_id: invitationId, p_tenant_slug: catalog.slug })).data).toMatchObject({ state: "ready", event_id: eventId });
    expect((await db.rpc("accept_planning_invitation", { p_invitation_id: invitationId, p_tenant_slug: catalog.slug })).data).toEqual({ state: "accepted", event_id: eventId });

    const { data: view } = await must(db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }));
    const v = view as { state: string; basics: { item_id: string; revision: number }; editing: { state: string }; structure: { stages: unknown[] } };
    expect(v.state).toBe("available");
    expect(v.editing.state).toBe("open");
    expect(v.structure.stages.length).toBeGreaterThan(0);
    const { data: saved } = await must(db.rpc("client_save_plan_item", { p_event_id: eventId, p_tenant_slug: catalog.slug, p_item_id: v.basics.item_id, p_expected_revision: v.basics.revision, p_answers: { guest_count: 140 } }));
    expect(saved).toMatchObject({ status: "saved" });
    const { data: reloaded } = await must(db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }));
    expect((reloaded as { basics: { answers: { guest_count?: number } } }).basics.answers.guest_count).toBe(140);

    const { data: home } = await must(db.rpc("my_events"));
    expect(home?.find((e) => e.event_id === eventId)).toMatchObject({ booking_source: "external", lifecycle_status: "lead" });
    expect((await db.rpc("my_contracts")).data).toEqual([]);
  });

  it("staff review the answers and get the web and PDF run sheet without any contract", async () => {
    const { data: staffView } = await must(owner.rpc("staff_planning_view", { p_event_id: eventId }));
    expect((staffView as { basics: { answers: { guest_count?: number } } }).basics.answers.guest_count).toBe(140);
    const loaded = (await loadRunSheet(owner, { id: catalog.tenantId, display_name: "IT it-external" }, eventId))!;
    expect(loaded.sheet.event.booked).toBe(true);
    expect(JSON.stringify(loaded.sheet)).not.toMatch(/contract|deposit/i);
    const pdf = await renderRunSheetPdf(loaded.sheet, loaded.revision);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await loadRunSheet(otherOwner, { id: catalog.tenantId, display_name: "x" }, eventId)).toBeNull();

    for (const table of ["proposals", "contracts", "event_payments"] as const) {
      const { count } = await must(admin.from(table).select("id", { count: "exact", head: true }).eq("event_id", eventId));
      expect(count, table).toBe(0);
    }
  });

  it("records no payment or invoice link for it, with a clear error and nothing written; a Flux event still records them", async () => {
    const pay = (id: string, cents: number) =>
      owner.rpc("record_event_payment", { p_event_id: id, p_amount_cents: cents, p_paid_on: "2026-10-01", p_reference: "e-transfer", p_note: "", p_idempotency_key: randomUUID() });
    const refused = await pay(eventId, 50_000);
    expect(refused.error?.code).toBe("22023");
    expect(describeDbError(refused.error)).toBe("This event was booked outside Flux DJ, so Flux DJ doesn't record its payments or invoice.");
    const invoice = await owner.rpc("set_event_invoice_url", { p_event_id: eventId, p_invoice_url: "https://pay.example.test/x", p_expected_version: 0 });
    expect(invoice.error?.code).toBe("22023");
    const direct = await admin.from("event_payments").insert({ tenant_id: catalog.tenantId, event_id: eventId, amount_cents: 100, currency: "CAD", paid_on: "2026-10-01", idempotency_key: randomUUID(), recorded_by_user_id: randomUUID(), recorded_by_email: "x@example.test" });
    expect(direct.error?.code).toBe("22023");
    for (const table of ["event_payments", "event_billing"] as const) {
      const { count } = await must(admin.from(table).select("event_id", { count: "exact", head: true }).eq("event_id", eventId));
      expect(count, table).toBe(0);
    }
    const { data: event } = await must(admin.from("events").select("lifecycle_status, booking_confirmed_at, booking_source").eq("id", eventId).single());
    expect(event).toEqual({ lifecycle_status: "lead", booking_confirmed_at: null, booking_source: "external" });

    const { data: flux } = await must(owner.from("events").insert({ tenant_id: catalog.tenantId, title: "IT flux payments", event_type: "wedding", event_date: "2027-07-02" }).select("id").single());
    const { data: recorded } = await must(pay(flux!.id, 12_345));
    expect(recorded).toMatchObject({ status: "recorded" });
    const { data: version } = await must(owner.rpc("set_event_invoice_url", { p_event_id: flux!.id, p_invoice_url: "https://pay.example.test/flux", p_expected_version: 0 }));
    expect(version).toBe(1);
  });

  it("a normal Flux event with a verified client still needs its booking before planning opens", async () => {
    const { data: event } = await must(owner.from("events").insert({ tenant_id: catalog.tenantId, title: "IT flux wedding", event_type: "wedding", event_date: "2027-07-01" }).select("id, booking_source").single());
    expect(event!.booking_source).toBe("flux");
    await must(owner.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: event!.id, client_id: clientId, is_primary: true, can_sign: true }));
    await must(owner.rpc("setup_event_plan", { p_event_id: event!.id, p_template_id: null as never }));
    // Not booked yet: no planning invitation (a booked Flux event can be invited; see flux-planning-invitations).
    const id = randomUUID();
    const refused = await owner.rpc("send_planning_invitation", { p_event_id: event!.id, p_invitation_id: id, p_token_hash: sha256Hex(planningInviteToken(id)) });
    expect(refused.error?.message).toMatch(/planning_invalid: the event isn't booked yet/);
  });
});
