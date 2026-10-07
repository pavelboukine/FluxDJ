/**
 * Business branding against the LOCAL stack: real logo processing, real
 * Storage, registration and the versioned branding change, for two dedicated
 * test businesses with generated logos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { frozenOfferLogo, liveBrand, LOGO_BUCKET, processLogo, storeLogo, type ProcessedLogo } from "@/lib/branding/logo.server";
import { adminClient, archiveTestTenants, createEvent, createTenantWithCatalog, draftAndSend, must, signedInUser, type Catalog, type Db } from "./support/fixtures";
import { transparentPng, opaqueJpeg } from "../support/logo-fixtures";

let admin: Db;
let ownerA: { id: string; db: Db };
let ownerB: { id: string; db: Db };
let staffA: { id: string; db: Db };
let a: Catalog;
let b: Catalog;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function processed(bytes: Buffer): Promise<ProcessedLogo> {
  const result = await processLogo(bytes);
  if (!result.ok) throw new Error(result.message);
  return result.logo;
}
const version = async (tenantId: string) =>
  (await must(admin.from("tenants").select("branding_version").eq("id", tenantId).single())).data!.branding_version;
const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());

beforeAll(async () => {
  admin = adminClient();
  const run = randomUUID().slice(0, 8);
  ownerA = await signedInUser(admin, `it-brand-a-${run}@example.test`);
  ownerB = await signedInUser(admin, `it-brand-b-${run}@example.test`);
  staffA = await signedInUser(admin, `it-brand-staff-${run}@example.test`);
  a = await createTenantWithCatalog(admin, ownerA.id, "it-brand-a");
  b = await createTenantWithCatalog(admin, ownerB.id, "it-brand-b");
  await must(admin.from("tenant_memberships").insert({ tenant_id: a.tenantId, user_id: staffA.id, role: "staff" }));
});

afterAll(async () => {
  await archiveTestTenants(admin, a?.tenantId, b?.tenantId);
});

describe("business branding (local Supabase)", () => {
  it("two businesses each show their own verified logo and colour", async () => {
    const logoA = await processed(await transparentPng(1200, 300));
    const logoB = await processed(await opaqueJpeg(300, 300));
    const storedA = await storeLogo(a.tenantId, ownerA.id, logoA);
    const storedB = await storeLogo(b.tenantId, ownerB.id, logoB);
    if (!storedA.ok || !storedB.ok) throw new Error("upload failed");
    expect(storedA.stored.path).toMatch(new RegExp(`^${a.tenantId}/logos/[0-9a-f-]{36}\\.png$`));
    await must(ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: 0, p_logo_id: storedA.stored.logoId, p_primary_color: "#1e3a8a" }));
    await must(ownerB.db.rpc("update_tenant_branding", { p_tenant_id: b.tenantId, p_expected_version: 0, p_logo_id: storedB.stored.logoId, p_primary_color: "#ffff00" }));

    const brandA = (await liveBrand(a.slug))!;
    const brandB = (await liveBrand(b.slug))!;
    expect(brandA.brandColors.primary).toBe("#1e3a8a");
    expect(brandB.brandColors.primary).toBe("#ffff00");
    expect(sha(await download(brandA.logo!.url))).toBe(logoA.sha256);
    expect(sha(await download(brandB.logo!.url))).toBe(logoB.sha256);
    expect([brandA.logo!.width, brandA.logo!.height]).toEqual([1024, 256]);

    // Neither owner can use the other business's logo.
    const crossed = await ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: 1, p_logo_id: storedB.stored.logoId, p_primary_color: null as unknown as string });
    expect(crossed.error?.message).toMatch(/branding_invalid/);
    // Staff of A read A's logos only, and can't change branding.
    const { data: seen } = await must(staffA.db.from("tenant_logos").select("tenant_id"));
    expect(new Set(seen!.map((r) => r.tenant_id))).toEqual(new Set([a.tenantId]));
    const staffChange = await staffA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: 1, p_logo_id: null as unknown as string, p_primary_color: null as unknown as string });
    expect(staffChange.error?.code).toBe("42501");
  });

  it("a sent proposal keeps its logo after the owner replaces and removes it", async () => {
    const { eventId } = await createEvent(admin, a, `it-brand-client-${randomUUID().slice(0, 8)}@example.test`);
    const { proposalId } = await draftAndSend(ownerA.db, a, eventId);
    const { data: proposal } = await must(admin.from("proposals").select("offer_snapshot").eq("id", proposalId).single());
    const offer = proposal!.offer_snapshot as { branding: { logo_storage_path: string | null } };
    const frozenBefore = await frozenOfferLogo(offer);
    const frozenBytes = await download(frozenBefore!.url);

    const replacement = await storeLogo(a.tenantId, ownerA.id, await processed(await transparentPng(300, 900, [16, 185, 129])));
    if (!replacement.ok) throw new Error("upload failed");
    await must(ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: await version(a.tenantId), p_logo_id: replacement.stored.logoId, p_primary_color: "#0f766e" }));
    await must(ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: await version(a.tenantId), p_logo_id: null as unknown as string, p_primary_color: null as unknown as string }));

    expect((await liveBrand(a.slug))!.logo).toBeNull();
    const frozenAfter = await frozenOfferLogo(offer);
    expect(sha(await download(frozenAfter!.url))).toBe(sha(frozenBytes));
  });

  it("a failed registration or a stale save leaves the current logo active and no stray file", async () => {
    const current = await storeLogo(a.tenantId, ownerA.id, await processed(await transparentPng(400, 100)));
    if (!current.ok) throw new Error("upload failed");
    await must(ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: await version(a.tenantId), p_logo_id: current.stored.logoId, p_primary_color: null as unknown as string }));
    const before = await admin.storage.from(LOGO_BUCKET).list(`${a.tenantId}/logos`, { limit: 1000 });

    // Uploaded by staff: refused at registration, and the upload is removed.
    const refused = await storeLogo(a.tenantId, staffA.id, await processed(await transparentPng(400, 100, [0, 0, 255])));
    expect(refused.ok).toBe(false);
    const after = await admin.storage.from(LOGO_BUCKET).list(`${a.tenantId}/logos`, { limit: 1000 });
    expect(after.data!.length).toBe(before.data!.length);

    // A stale tab's save is a conflict (PT409) and changes nothing.
    const stale = await ownerA.db.rpc("update_tenant_branding", { p_tenant_id: a.tenantId, p_expected_version: 0, p_logo_id: null as unknown as string, p_primary_color: "#000000" });
    expect(stale.error?.code).toBe("PT409");
    const { data: tenant } = await must(admin.from("tenants").select("logo_storage_path").eq("id", a.tenantId).single());
    expect(tenant!.logo_storage_path).toBe(current.stored.path);
  });
});
