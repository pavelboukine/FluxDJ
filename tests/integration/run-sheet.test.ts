/**
 * The run sheet against the LOCAL stack, through the real staff session,
 * RLS and planning functions: one consistent snapshot while links are being
 * rewritten concurrently, staff changes after the client deadline appearing
 * (with a new revision), refusals for clients, other businesses and anon,
 * and no staff-only data in the projection. Dedicated test tenants, archived
 * afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { loadRunSheet } from "@/lib/run-sheet/load.server";
import { staffPlanningViewSchema } from "@/lib/planning/view";
import { adminClient, archiveTestTenants, createTenantWithCatalog, localStatus, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { sql, uuid } from "./support/sql";

let admin: Db;
let catalog: Catalog;
let other: Catalog;
let owner: Db;
let otherOwner: Db;
let client: { id: string; db: Db };
const tenants: string[] = [];
let eventId = "";
const items = new Map<string, string>();

const tenantRow = () => ({ id: catalog.tenantId, display_name: "IT run sheet" });
const save = async (key: string, answers: Record<string, unknown>) => {
  const { data: r } = await must(admin.from("event_plan_responses").select("revision").eq("item_id", items.get(key)!).maybeSingle());
  const { data } = await must(owner.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: items.get(key)!, p_expected_revision: r?.revision ?? 0, p_answers: answers as never }));
  expect(data).toMatchObject({ status: "saved" });
};
const song = (title: string, artist: string, extra: Record<string, string> = {}) => ({ id: randomUUID(), title, artist, ...extra });

describe("run sheet (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const o = await signedInUser(admin, `it-runsheet-owner-${randomUUID().slice(0, 8)}@example.test`);
    owner = o.db;
    catalog = await createTenantWithCatalog(admin, o.id, "it-runsheet");
    tenants.push(catalog.tenantId);
    const ob = await signedInUser(admin, `it-runsheet-other-${randomUUID().slice(0, 8)}@example.test`);
    otherOwner = ob.db;
    other = await createTenantWithCatalog(admin, ob.id, "it-runsheet-b");
    tenants.push(other.tenantId);
    client = await signedInUser(admin, `it-runsheet-client-${randomUUID().slice(0, 8)}@example.test`);

    eventId = randomUUID();
    const clientId = randomUUID();
    await must(admin.from("clients").insert({ id: clientId, tenant_id: catalog.tenantId, name: "IT Couple", email: `it-rs-${eventId.slice(0, 8)}@example.test`, phone: "819 555-0100" }));
    await must(admin.from("events").insert({
      id: eventId, tenant_id: catalog.tenantId, title: "IT run-sheet wedding", event_type: "wedding", event_date: "2027-07-10",
      venue_name: "Domaine IT", internal_notes: "IT INTERNAL NOTE never on the run sheet",
    }));
    await must(admin.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, is_primary: true, can_sign: true }));
    await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: clientId, user_id: client.id }));
    await must(owner.rpc("install_starter_planning_templates", { p_tenant_id: catalog.tenantId }));
    const { data: wedding } = await must(admin.from("planning_templates").select("id").eq("tenant_id", catalog.tenantId).eq("starter_key", "wedding").single());
    await must(owner.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: wedding!.id }));
    sql(`select set_config('flux.booking_event', ${uuid(eventId)}::text, false);
         update public.events set lifecycle_status = 'booked', booking_confirmed_at = now() where id = ${uuid(eventId)};`);
    const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
    for (const i of plan!.event_plan_items) items.set(i.key, i.id);
  }, 120_000);

  afterAll(async () => {
    await archiveTestTenants(admin, ...tenants);
  });

  it("projects the saved plan with links resolved and nothing staff-only", async () => {
    const a = song("September", "Earth, Wind & Fire", { cue: "Parents" });
    const b = song("Crazy in Love", "Beyoncé", { cue: "Couple" });
    await save("basics", { guest_count: 120, start_time: "16:00", end_time: "00:30", access_notes: "Door 4" });
    await save("entrance_music", { songs: [a, b] });
    await save("introductions", { entries: [
      { id: randomUUID(), names: "Parents", song_id: a.id }, { id: randomUUID(), names: "Grandparents", song_id: a.id },
      { id: randomUUID(), names: "Chloé et François", pronunciation: "klo-AY", song_id: b.id },
    ] });
    await save("do_not_play", { songs: [song("Macarena", "Los del Río")] });
    const loaded = (await loadRunSheet(owner, tenantRow(), eventId))!;
    const entrance = loaded.sheet.stages.find((s) => s.key === "reception_entrance")!;
    expect(entrance.rows.filter((r) => r.title.startsWith("Introductions")).map((r) => [r.people.map((p) => p.names), r.songs.map((s) => s.title)])).toEqual([
      [["Parents", "Grandparents"], ["September"]],
      [["Chloé et François"], ["Crazy in Love"]],
    ]);
    expect(loaded.sheet.times[0].value).toBe("16:00 – 00:30 (next day, Sun, Jul 11)");
    const json = JSON.stringify(loaded.sheet);
    for (const secret of ["IT INTERNAL NOTE", "@example.test", "IT-REF", "reason", "updated_by"]) expect(json).not.toContain(secret);
    expect(loaded.revision).toMatch(/^[0-9A-F]{8}$/);
  });

  it("reads one consistent snapshot while links are rewritten concurrently", async () => {
    let current = song("Song 0", "Artist");
    // Unlink first: the database refuses to remove songs introductions still point at.
    await save("introductions", { entries: [{ id: randomUUID(), names: "Wedding party" }] });
    await save("entrance_music", { songs: [current] });
    await save("introductions", { entries: [{ id: randomUUID(), names: "Wedding party", song_id: current.id }] });
    const introId = randomUUID();
    let stop = false;
    const writer = (async () => {
      for (let i = 1; i <= 15; i++) {
        const next = song(`Song ${i}`, "Artist");
        await save("entrance_music", { songs: [current, next] }); // add the new song
        await save("introductions", { entries: [{ id: introId, names: "Wedding party", song_id: next.id }] }); // relink
        await save("entrance_music", { songs: [next] }); // drop the old, now unlinked
        current = next;
      }
      stop = true;
    })();
    let reads = 0;
    const reader = async () => {
      while (!stop) {
        const { data } = await must(owner.rpc("staff_planning_view", { p_event_id: eventId }));
        const view = staffPlanningViewSchema.parse(data);
        if (view.plan === null) throw new Error("no plan");
        const songs = (view.music[items.get("entrance_music")!]?.answers.songs ?? []).map((s) => s.id);
        const links = ((view.moments[items.get("introductions")!]?.answers.entries ?? []) as { song_id?: string }[]).map((e) => e.song_id);
        for (const l of links) expect(songs).toContain(l);
        const sheet = (await loadRunSheet(owner, tenantRow(), eventId))!.sheet;
        const rows = sheet.stages.find((s) => s.key === "reception_entrance")!.rows.filter((r) => r.title.startsWith("Introductions"));
        expect(rows.every((r) => r.songs.length === 1 && !r.warning)).toBe(true);
        reads++;
      }
    };
    await Promise.all([writer, reader(), reader()]);
    expect(reads).toBeGreaterThan(5);
  }, 120_000);

  it("staff changes after the client deadline appear in the next load, with a new revision", async () => {
    sql(`select private.set_plan_cutoff_columns(${uuid(eventId)}, clock_timestamp() - interval '1 day', null);`);
    const before = (await loadRunSheet(owner, tenantRow(), eventId))!;
    expect(before.sheet.editing).toMatch(/^Client editing closed since/);
    await save("basics", { guest_count: 135, start_time: "16:00", end_time: "00:30", access_notes: "Door 4, then elevator B" });
    const after = (await loadRunSheet(owner, tenantRow(), eventId))!;
    expect(after.sheet.times.find((t) => t.label === "Guests")!.value).toBe("135");
    expect(after.sheet.essentials.find((e) => e.label === "Access and load-in")!.value).toBe("Door 4, then elevator B");
    expect(after.revision).not.toBe(before.revision);
    expect((await loadRunSheet(owner, tenantRow(), eventId))!.revision).toBe(after.revision);
  });

  it("refuses clients, other businesses and anon; archived events stay readable for staff", async () => {
    expect(await loadRunSheet(client.db, tenantRow(), eventId)).toBeNull();
    expect(await loadRunSheet(otherOwner, tenantRow(), eventId)).toBeNull();
    expect(await loadRunSheet(otherOwner, { id: other.tenantId, display_name: "x" }, eventId)).toBeNull();
    const env = localStatus();
    const anon = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } }) as unknown as Db;
    expect(await loadRunSheet(anon, tenantRow(), eventId)).toBeNull();
    await must(owner.rpc("set_event_archived", { p_event_id: eventId, p_archived: true }));
    const archived = (await loadRunSheet(owner, tenantRow(), eventId))!;
    expect(archived.sheet.event.archived).toBe(true);
    expect(archived.sheet.stages.length).toBeGreaterThan(3);
    await must(owner.rpc("set_event_archived", { p_event_id: eventId, p_archived: false }));
  });
});
