/**
 * Playlist links on music lists against the LOCAL stack, through the real
 * API and roles: a client of an event booked elsewhere attaches playlists
 * through client_save_plan_item, reads them back through the planning view
 * the app parses, and gets conflicts for stale tabs; other clients and other
 * businesses can't save; staff see the links on the web run sheet model and
 * as clickable links in the PDF. Nothing is fetched from any music service.
 * Dedicated it- tenants, archived afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { musicAnswersFromForm, musicFormFromAnswers } from "@/lib/planning/music";
import { clientPlanningViewSchema } from "@/lib/planning/view";
import { loadRunSheet } from "@/lib/run-sheet/load.server";
import { renderRunSheetPdf } from "@/lib/run-sheet/render.server";
import { pdfLinks } from "../support/pdf";
import { adminClient, archiveTestTenants, createTenantWithCatalog, must, signedInUser, type Catalog, type Db } from "./support/fixtures";

const run = randomUUID().slice(0, 8);
const SPOTIFY = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=it";
const YTM = "https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG";
let admin: Db;
let owner: Db;
let otherOwner: Db;
let client: { id: string; db: Db };
let stranger: { id: string; db: Db };
let catalog: Catalog;
let other: Catalog;
let eventId = "";
const items = new Map<string, string>();

const save = (db: Db, key: string, revision: number, answers: unknown) =>
  db.rpc("client_save_plan_item", { p_event_id: eventId, p_tenant_slug: catalog.slug, p_item_id: items.get(key)!, p_expected_revision: revision, p_answers: answers as never });

beforeAll(async () => {
  admin = adminClient();
  const me = await signedInUser(admin, `it-playlists-owner-${run}@example.test`);
  owner = me.db;
  catalog = await createTenantWithCatalog(admin, me.id, "it-playlists");
  const o = await signedInUser(admin, `it-playlists-other-${run}@example.test`);
  otherOwner = o.db;
  other = await createTenantWithCatalog(admin, o.id, "it-playlists-other");

  const email = `it-playlists-client-${run}@example.test`;
  const { data: c } = await must(owner.from("clients").insert({ tenant_id: catalog.tenantId, name: "Sam Playlist", email }).select("id").single());
  const { data: event } = await must(
    owner.from("events").insert({ tenant_id: catalog.tenantId, title: "IT playlist wedding", event_type: "wedding", event_date: "2027-07-10", booking_source: "external" }).select("id").single(),
  );
  eventId = event!.id;
  await must(owner.from("event_clients").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: c!.id, is_primary: true, can_sign: true }));
  await must(owner.rpc("install_starter_planning_templates", { p_tenant_id: catalog.tenantId }));
  const { data: template } = await must(owner.from("planning_templates").select("id").eq("tenant_id", catalog.tenantId).eq("starter_key", "wedding").single());
  await must(owner.rpc("setup_event_plan", { p_event_id: eventId, p_template_id: template!.id }));
  client = await signedInUser(admin, email);
  await must(admin.from("event_access").insert({ tenant_id: catalog.tenantId, event_id: eventId, client_id: c!.id, user_id: client.id }));
  stranger = await signedInUser(admin, `it-playlists-stranger-${run}@example.test`);
  const { data: plan } = await must(admin.from("event_plans").select("event_plan_items(id, key)").eq("event_id", eventId).single());
  for (const i of plan!.event_plan_items) items.set(i.key, i.id);
}, 120_000);

afterAll(async () => {
  await archiveTestTenants(admin, catalog?.tenantId, other?.tenantId);
});

describe("playlist links (local Supabase)", () => {
  const cocktail = { playlists: [{ id: randomUUID(), url: SPOTIFY, label: "Cocktail Hour", notes: "Relaxed indie" }, { id: randomUUID(), url: YTM }] };

  it("the client attaches playlists; the view the app parses keeps them, and they complete the list", async () => {
    const { data } = await must(save(client.db, "cocktail_music", 0, cocktail));
    expect(data).toMatchObject({ status: "saved", revision: 1, answers: cocktail });
    const { data: raw } = await must(client.db.rpc("client_planning_view", { p_event_id: eventId, p_tenant_slug: catalog.slug }));
    const view = clientPlanningViewSchema.parse(raw);
    if (view.state !== "available") throw new Error(`planning available expected, got ${view.state}`);
    const answers = view.music[items.get("cocktail_music")!].answers;
    expect(answers).toEqual(cocktail);
    // The editor's form round-trips them unchanged, so the next autosave keeps them.
    expect(musicAnswersFromForm("music_background", musicFormFromAnswers(answers))).toEqual({ ok: true, answers: cocktail });
    expect(view.progress.items.find((i) => i.key === "cocktail_music")!.requirements).toEqual([{ key: "songs", state: "answered" }]);
  }, 60_000);

  it("a stale tab gets a conflict and a retried save adds nothing twice", async () => {
    expect((await must(save(client.db, "cocktail_music", 0, { playlists: [{ id: randomUUID(), url: "https://example.com/other" }] }))).data).toMatchObject({ status: "conflict" });
    expect((await must(save(client.db, "cocktail_music", 0, cocktail))).data).toMatchObject({ status: "saved", revision: 1 });
    const { data: row } = await must(admin.from("event_plan_responses").select("answers, revision").eq("item_id", items.get("cocktail_music")!).single());
    expect(row).toEqual({ answers: cocktail, revision: 1 });
  }, 60_000);

  it("refuses unsafe links and playlists on song moments", async () => {
    expect((await must(save(client.db, "must_play", 0, { playlists: [{ id: randomUUID(), url: "javascript:alert(1)" }] }))).data).toMatchObject({ status: "invalid" });
    expect((await must(save(client.db, "first_dance", 0, { playlists: [{ id: randomUUID(), url: SPOTIFY }] }))).data).toMatchObject({ status: "invalid", field: "playlists" });
  }, 60_000);

  it("other clients and other businesses can't save", async () => {
    expect((await must(save(stranger.db, "must_play", 0, { playlists: [{ id: randomUUID(), url: SPOTIFY }] }))).data).toEqual({ status: "unavailable" });
    const foreign = await otherOwner.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: items.get("must_play")!, p_expected_revision: 0, p_answers: { playlists: [] } });
    expect(foreign.error?.code).toBe("P0002");
    expect((await admin.from("event_plan_responses").select("id").eq("item_id", items.get("must_play")!)).data).toEqual([]);
  }, 60_000);

  it("staff see the playlists on the run sheet and as clickable links in its PDF", async () => {
    await must(owner.rpc("staff_save_plan_item", { p_event_id: eventId, p_item_id: items.get("do_not_play")!, p_expected_revision: 0, p_answers: { playlists: [{ id: randomUUID(), url: "https://playlists.example.org/avoid", label: "Please avoid" }] } }));
    const loaded = (await loadRunSheet(owner, { id: catalog.tenantId, display_name: "IT it-playlists" }, eventId))!;
    expect(loaded.sheet.musicLists.find((l) => l.key === "cocktail_music")!.playlists.map((p) => [p.kind, p.label ?? null])).toEqual([
      ["Spotify playlist", "Cocktail Hour"], ["YouTube Music playlist", null],
    ]);
    expect(loaded.sheet.musicLists.find((l) => l.key === "do_not_play")!.playlists[0]).toMatchObject({ kind: "Playlist link", host: "playlists.example.org" });
    const links = await pdfLinks(await renderRunSheetPdf(loaded.sheet, loaded.revision));
    for (const url of [SPOTIFY, YTM, "https://playlists.example.org/avoid"]) expect(links).toContain(url);
    expect(await loadRunSheet(otherOwner, { id: catalog.tenantId, display_name: "x" }, eventId)).toBeNull();
  }, 60_000);
});
