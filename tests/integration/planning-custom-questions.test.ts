/**
 * Custom planning questions (20261202000100) against the LOCAL stack, through
 * the real API and roles: the views parse with the app's schemas; incomplete
 * custom answers save; a client and staff saving the same item at once
 * never overwrite each other (one saves, the other gets a conflict); staff
 * removing a question while the client answers it never leaves an answer
 * without its question (it is kept, archived) nor loses one; and two staff
 * changing the questions at once are versioned. Dedicated it- tenant,
 * archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { clientPlanningViewSchema, staffPlanningViewSchema } from "@/lib/planning/view";
import type { Json } from "@/lib/supabase/database.types";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, uuid } from "./support/sql";

const run = randomUUID().slice(0, 8);
let admin: Db;
let catalog: Catalog;
let owner: Db;
let staff: Db;
let client: { id: string; db: Db };

const QUESTIONS = [
  { id: "q_style", type: "single_choice", label: "Which traditions?", required: true, options: [{ id: "o_greek", label: "Greek" }, { id: "o_none", label: "None" }] },
  { id: "q_name", type: "short_text", label: "Family name", required: false },
  { id: "q_hora", type: "yes_no", label: "A hora?", required: true },
];

/** A booked event whose plan is open to the client, with one custom section holding QUESTIONS. */
async function planWithSection(): Promise<{ eventId: string; itemId: string }> {
  const { eventId, clientId } = await createEvent(admin, catalog, `it-custom-contact-${randomUUID().slice(0, 8)}@example.test`);
  await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, user_id: client.id }));
  await must(staff.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: null as unknown as string }));
  sql(`select set_config('flux.booking_event', ${uuid(eventId)}::text, false);
       update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ${uuid(eventId)};`);
  await must(staff.rpc("open_client_planning", { p_event_id: eventId }));
  const added = (await must(staff.rpc("add_custom_event_plan_item", { p_event_id: eventId, p_expected_version: await version(eventId), p_kind: "general", p_label: "Cultural music" }))).data as { item_id: string };
  await must(staff.rpc("set_event_plan_item_questions", { p_item_id: added.item_id, p_expected_version: await version(eventId), p_questions: QUESTIONS }));
  return { eventId, itemId: added.item_id };
}
const version = async (eventId: string) =>
  ((await must(admin.from("event_plans").select("structure_version").eq("event_id", eventId).single())).data as { structure_version: number }).structure_version;
const stored = async (itemId: string) =>
  (await admin.from("event_plan_responses").select("answers, revision").eq("item_id", itemId).maybeSingle()).data as { answers: Record<string, unknown>; revision: number } | null;
const definitions = async (itemId: string) =>
  ((await must(admin.from("event_plan_items").select("questions").eq("id", itemId).single())).data as { questions: { id: string; archived?: boolean }[] }).questions;
const clientSave = (eventId: string, itemId: string, revision: number, answers: Record<string, unknown>) =>
  client.db.rpc("client_save_plan_item", { p_event_id: eventId, p_tenant_slug: catalog.slug, p_item_id: itemId, p_expected_revision: revision, p_answers: answers as Json });
const staffSave = (eventId: string, itemId: string, revision: number, answers: Record<string, unknown>) =>
  staff.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: itemId, p_expected_revision: revision, p_answers: answers as Json });
const status = (r: { data: unknown }) => (r.data as { status: string }).status;

beforeAll(async () => {
  admin = adminClient();
  const o = await signedInUser(admin, `it-custom-owner-${run}@example.test`);
  owner = o.db;
  catalog = await createTenantWithCatalog(admin, o.id, "it-custom");
  const s = await signedInUser(admin, `it-custom-staff-${run}@example.test`);
  await must(admin.from("tenant_memberships").insert({ tenant_id: catalog.tenantId, user_id: s.id, role: "staff" }));
  staff = s.db;
  client = await signedInUser(admin, `it-custom-${run}@example.test`);
}, 60_000);

afterAll(async () => {
  if (admin) await archiveTestTenants(admin, catalog?.tenantId);
});

describe("custom planning questions (local Supabase)", () => {
  it("the client and staff views carry the questions and parse with the app's schemas; incomplete answers save", async () => {
    const { eventId, itemId } = await planWithSection();
    const saved = await must(clientSave(eventId, itemId, 0, { q_name: "Papadopoulos" }));
    expect(saved.data).toMatchObject({ status: "saved", revision: 1, answers: { q_name: "Papadopoulos" } });
    const progress = (saved.data as { progress: { items: { item_id: string; met: number; total: number; state: string }[] } }).progress.items.find((i) => i.item_id === itemId);
    expect(progress).toMatchObject({ met: 0, total: 2, state: "in_progress" });

    const clientView = clientPlanningViewSchema.parse((await must(client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }))).data);
    if (clientView.state !== "available") throw new Error(`expected an available plan, got ${clientView.state}`);
    const section = clientView.structure.general.find((g) => g.id === itemId)!;
    expect(section).toMatchObject({ editor: "custom", label: "Cultural music" });
    expect(section.questions?.map((q) => q.id)).toEqual(["q_style", "q_name", "q_hora"]);
    expect(clientView.moments[itemId]).toEqual({ answers: { q_name: "Papadopoulos" }, revision: 1 });

    const staffView = staffPlanningViewSchema.parse((await must(owner.rpc("staff_planning_view", { p_event_id: eventId }))).data);
    if (staffView.plan === null) throw new Error("expected a plan");
    expect(staffView.structure.general.find((g) => g.id === itemId)?.questions).toHaveLength(3);
  }, 60_000);

  it("a client and staff saving the same custom section at once: one saves, the other is a conflict, nothing is overwritten", async () => {
    const { eventId, itemId } = await planWithSection();
    await must(clientSave(eventId, itemId, 0, { q_name: "First" }));
    const [fromClient, fromStaff] = await Promise.all([
      clientSave(eventId, itemId, 1, { q_name: "Client's", q_hora: true }),
      staffSave(eventId, itemId, 1, { q_name: "Staff's", q_style: "o_none" }),
    ]);
    expect([fromClient.error, fromStaff.error]).toEqual([null, null]);
    expect([status(fromClient), status(fromStaff)].sort()).toEqual(["conflict", "saved"]);
    const winner = status(fromClient) === "saved" ? { q_name: "Client's", q_hora: true } : { q_name: "Staff's", q_style: "o_none" };
    expect(await stored(itemId)).toEqual({ answers: winner, revision: 2 });
  }, 60_000);

  it("staff removing a question while the client answers it: the answer is never lost or left without its question", async () => {
    for (let round = 0; round < 4; round++) {
      const { eventId, itemId } = await planWithSection();
      const v = await version(eventId);
      const [save, removal] = await Promise.all([
        clientSave(eventId, itemId, 0, { q_name: "Nguyen", q_hora: false }),
        staff.rpc("set_event_plan_item_questions", { p_item_id: itemId, p_expected_version: v, p_questions: QUESTIONS.filter((q) => q.id !== "q_hora") }),
      ]);
      expect(removal.error).toBeNull();
      expect(save.error).toBeNull();
      const answers = (await stored(itemId))?.answers ?? {};
      const hora = (await definitions(itemId)).find((q) => q.id === "q_hora");
      if (status(save) === "saved") {
        // The save came first: the removal kept the answered question, archived.
        expect(answers).toEqual({ q_name: "Nguyen", q_hora: false });
        expect(hora).toMatchObject({ archived: true });
      } else {
        // The removal came first: the save was refused (reload), and nothing was stored.
        expect(save.data).toMatchObject({ status: "invalid", message: "These questions were changed. Reload the page to see the latest version, then try again." });
        expect(answers).toEqual({});
        expect(hora).toBeUndefined();
      }
    }
  }, 120_000);

  it("two staff changing the questions at once: one succeeds, the other is told it changed elsewhere", async () => {
    const { eventId, itemId } = await planWithSection();
    const v = await version(eventId);
    const results = await Promise.all([
      owner.rpc("set_event_plan_item_questions", { p_item_id: itemId, p_expected_version: v, p_questions: [...QUESTIONS, { id: "q_a", type: "time", label: "Start", required: false }] }),
      staff.rpc("set_event_plan_item_questions", { p_item_id: itemId, p_expected_version: v, p_questions: [...QUESTIONS, { id: "q_b", type: "songs", label: "Songs", required: false }] }),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error !== null)?.error?.code).toBe("PT409");
    expect((await definitions(itemId)).map((q) => q.id)).toHaveLength(4);
    expect(await version(eventId)).toBe(v + 1);
  }, 60_000);

  it("templates: staff (not only the owner) author custom items; clients can't; two staff saving questions at once are versioned", async () => {
    const templateId = randomUUID();
    await must(owner.rpc("create_planning_template_once", {
      p_tenant_id: catalog.tenantId, p_template_id: templateId, p_start: "basics", p_source_template_id: null as unknown as string, p_name: `Custom ${run}`, p_description: null as unknown as string,
    }));
    const tversion = async () => ((await must(admin.from("planning_templates").select("version").eq("id", templateId).single())).data as { version: number }).version;
    const added = await staff.rpc("add_custom_planning_template_item", { p_template_id: templateId, p_expected_version: await tversion(), p_kind: "general", p_label: "Cultural music" });
    expect(added.error).toBeNull();
    const itemId = (added.data as { item_id: string }).item_id;
    const refused = await client.db.rpc("add_custom_planning_template_item", { p_template_id: templateId, p_expected_version: await tversion(), p_kind: "general", p_label: "Client" });
    expect(refused.error?.code).toBe("P0002");
    const byClient = await client.db.rpc("set_planning_template_item_questions", { p_item_id: itemId, p_expected_version: await tversion(), p_questions: QUESTIONS });
    expect(byClient.error?.code).toBe("P0002");

    const v = await tversion();
    const results = await Promise.all([
      owner.rpc("set_planning_template_item_questions", { p_item_id: itemId, p_expected_version: v, p_questions: QUESTIONS }),
      staff.rpc("set_planning_template_item_questions", { p_item_id: itemId, p_expected_version: v, p_questions: QUESTIONS.slice(0, 1) }),
    ]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.find((r) => r.error !== null)?.error?.code).toBe("PT409");
    const stored = ((await must(admin.from("planning_template_items").select("questions").eq("id", itemId).single())).data as { questions: unknown[] }).questions;
    expect(stored).toHaveLength(results[0].error === null ? 3 : 1);
    expect(await tversion()).toBe(v + 1);
  }, 60_000);
});
