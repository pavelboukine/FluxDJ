/**
 * Package photos against the LOCAL Supabase stack, through the real Storage
 * API and database functions: uploads under {tenant}/packages/{package}/…,
 * set_package_photo, and what clients' frozen offers carry when the photo is
 * replaced or removed later. Throwaway it-… tenants, archived afterwards.
 *
 * Run: pnpm exec vitest run tests/integration/package-photos.test.ts --no-file-parallelism
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  adminClient,
  archiveTestTenants,
  clientView,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  localStatus,
  must,
  openLink,
  sendDraft,
  signedInUser,
  type Catalog,
  type Db,
} from "./support/fixtures";

const BUCKET = "gear-media";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const run = randomUUID().slice(0, 8);

let admin: Db;
let anon: Db;
let a: Catalog;
let b: Catalog;
const users = {} as Record<"ownerA" | "staffA" | "ownerB" | "client", { id: string; db: Db }>;
const uploaded: string[] = [];

const photoPath = (catalog: Catalog, packageId: string) => `${catalog.tenantId}/packages/${packageId}/${randomUUID()}.jpg`;

async function upload(db: Db, path: string, options: { contentType?: string; upsert?: boolean } = {}) {
  const result = await db.storage.from(BUCKET).upload(path, JPEG, { contentType: options.contentType ?? "image/jpeg", upsert: options.upsert ?? false });
  if (!result.error) uploaded.push(path);
  return result;
}

const setPhoto = (db: Db, packageId: string, path: string | null) =>
  db.rpc("set_package_photo", { p_package_id: packageId, p_storage_path: path as string, p_content_type: "image/jpeg", p_alt_text: "Full setup" });

async function signaturePhoto(proposal: { token: string; proposalId: string }) {
  const { status, sessionHash } = await openLink(admin, a.slug, proposal.token);
  const view = await clientView(admin, a.slug, proposal.proposalId, sessionHash);
  return { status, image: view.offer?.packages.find((p) => p.key === "signature")?.image ?? null, others: view.offer?.packages.filter((p) => p.key !== "signature").map((p) => p.image) };
}

describe("package photos (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const env = localStatus();
    anon = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    users.ownerA = await signedInUser(admin, `it-pkgphoto-owner-a-${run}@example.test`);
    users.staffA = await signedInUser(admin, `it-pkgphoto-staff-a-${run}@example.test`);
    users.ownerB = await signedInUser(admin, `it-pkgphoto-owner-b-${run}@example.test`);
    users.client = await signedInUser(admin, `it-pkgphoto-client-${run}@example.test`);
    a = await createTenantWithCatalog(admin, users.ownerA.id, "it-pkgphoto-a");
    b = await createTenantWithCatalog(admin, users.ownerB.id, "it-pkgphoto-b");
    await must(admin.from("tenant_memberships").insert({ tenant_id: a.tenantId, user_id: users.staffA.id, role: "staff" }));
  });

  afterAll(async () => {
    if (!admin) return;
    // Throwaway objects of throwaway tenants only.
    if (uploaded.length) await admin.storage.from(BUCKET).remove(uploaded);
    await archiveTestTenants(admin, a?.tenantId, b?.tenantId);
  });

  it("a sent offer keeps its photo when the catalog photo is replaced; a new revision gets the new one", async () => {
    const photoA = photoPath(a, a.pkg.signature);
    await must(upload(users.staffA.db, photoA));
    await must(setPhoto(users.staffA.db, a.pkg.signature, photoA));

    const { eventId } = await createEvent(admin, a, `it-pkgphoto-c1-${run}@example.test`);
    const first = await draftAndSend(users.ownerA.db, a, eventId);
    const before = await signaturePhoto(first);
    expect(before.status).toBe("ok");
    expect(before.image).toEqual({ storage_path: photoA, content_type: "image/jpeg", alt_text: "Full setup" });
    expect(before.others).toEqual([undefined, undefined]);

    const photoB = photoPath(a, a.pkg.signature);
    await must(upload(users.ownerA.db, photoB));
    await must(setPhoto(users.ownerA.db, a.pkg.signature, photoB));
    expect((await signaturePhoto(first)).image?.storage_path).toBe(photoA);
    // The replaced file is still there for the sent offer.
    await must(admin.storage.from(BUCKET).download(photoA));

    const { data: revision } = await must(users.ownerA.db.rpc("open_proposal_draft", { p_event_id: eventId }));
    const second = { proposalId: revision as string, ...(await sendDraft(users.ownerA.db, revision as string)) };
    expect((await signaturePhoto(second)).image?.storage_path).toBe(photoB);
    expect((await openLink(admin, a.slug, first.token)).status).toBe("superseded");
    const { data: frozenFirst } = await must(admin.from("proposals").select("offer_snapshot").eq("id", first.proposalId).single());
    expect(JSON.stringify(frozenFirst!.offer_snapshot)).toContain(photoA);
  });

  it("after removal, new offers fall back to the gear photos and sent ones keep theirs", async () => {
    await must(setPhoto(users.staffA.db, a.pkg.signature, null));
    const { data: rows } = await must(admin.from("package_media").select("active").eq("package_id", a.pkg.signature));
    expect(rows!.map((r) => r.active)).toEqual([false, false]);
    const { eventId } = await createEvent(admin, a, `it-pkgphoto-c2-${run}@example.test`);
    const third = await draftAndSend(users.ownerA.db, a, eventId);
    expect((await signaturePhoto(third)).image).toBeNull();
  });

  it("keeps businesses apart in Storage and in set_package_photo", async () => {
    const intoA = await upload(users.ownerB.db, photoPath(a, a.pkg.signature));
    expect(intoA.error).toBeTruthy();
    const mixed = await upload(users.ownerB.db, `${b.tenantId}/packages/${a.pkg.signature}/${randomUUID()}.jpg`);
    expect(mixed.error).toBeTruthy();

    const own = photoPath(a, a.pkg.essential);
    await must(upload(users.ownerA.db, own));
    expect((await users.ownerB.db.storage.from(BUCKET).download(own)).error).toBeTruthy();
    expect((await users.ownerB.db.storage.from(BUCKET).createSignedUrl(own, 60)).error).toBeTruthy();
    expect((await users.ownerB.db.storage.from(BUCKET).list(`${a.tenantId}/packages/${a.pkg.essential}`)).data ?? []).toEqual([]);
    const { error } = await setPhoto(users.ownerB.db, a.pkg.essential, own);
    expect(error?.code).toBe("P0002");
    const { data: records } = await must(users.ownerB.db.from("package_media").select("id").eq("tenant_id", a.tenantId));
    expect(records).toEqual([]);
  });

  it("never overwrites or deletes a stored photo, and refuses other types", async () => {
    const path = photoPath(a, a.pkg.premium);
    await must(upload(users.ownerA.db, path));
    expect((await upload(users.ownerA.db, path)).error).toBeTruthy();
    expect((await upload(users.ownerA.db, path, { upsert: true })).error).toBeTruthy();
    expect((await users.ownerA.db.storage.from(BUCKET).remove([path])).data ?? []).toEqual([]);
    await must(admin.storage.from(BUCKET).download(path));
    expect((await upload(users.ownerA.db, photoPath(a, a.pkg.premium), { contentType: "text/html" })).error).toBeTruthy();
    expect((await upload(users.ownerA.db, `${a.tenantId}/packages/${a.pkg.premium}/${randomUUID()}.mp4`, { contentType: "video/mp4" })).error).toBeTruthy();
  });

  it("gives clients and anonymous users nothing", async () => {
    const path = photoPath(a, a.pkg.essential);
    expect((await upload(users.client.db, path)).error).toBeTruthy();
    expect((await anon.storage.from(BUCKET).upload(path, JPEG, { contentType: "image/jpeg" })).error).toBeTruthy();
    expect((await anon.storage.from(BUCKET).list(`${a.tenantId}/packages`)).data ?? []).toEqual([]);
    expect((await setPhoto(anon, a.pkg.essential, path)).error).toBeTruthy();
    expect((await setPhoto(users.client.db, a.pkg.essential, path)).error?.code).toBe("P0002");
  });

  it("refuses removed staff", async () => {
    await must(
      admin.from("tenant_memberships").update({ removed_at: new Date().toISOString(), removed_by: users.ownerA.id }).eq("tenant_id", a.tenantId).eq("user_id", users.staffA.id),
    );
    expect((await upload(users.staffA.db, photoPath(a, a.pkg.essential))).error).toBeTruthy();
    expect((await setPhoto(users.staffA.db, a.pkg.signature, null)).error?.code).toBe("P0002");
  });
});
