/**
 * Contract signing against the LOCAL stack with real Supabase Auth, Storage
 * and Postgres: Storage authorization, the upload -> commit ordering with
 * failed uploads, failed commits and crashes, replays after a lost
 * response, concurrent attempts, and races with void and revisions.
 * Everything runs in dedicated test tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs, type RequestEvidence } from "@/lib/contracts/signing.server";
import { SIGNATURE_BUCKET, type SignInput } from "@/lib/contracts/signing";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import {
  adminClient,
  archiveTestTenants,
  bothSeparate,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  localStatus,
  must,
  openLink,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";

const SECTIONS = [{ heading: "Parties", body: "{{business.legal_name}} and {{client.name}}. Total {{pricing.total}}." }];
const REQUEST: RequestEvidence = { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" };

let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;
let otherStaff: Db;

function signaturePng(seed = 0): string {
  const w = 900, h = 300;
  const rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < 600; t++) {
    const x = 150 + t, y = Math.round(150 + Math.sin((t + seed) / 20) * 60);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${encodeRgbaPng(rgba, w, h).toString("base64")}`;
}

/** A sent DEMO contract whose signer is a verified, signed-in client with event access. */
async function sentContract() {
  const clientEmail = `it-sign-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId } = await createEvent(admin, catalog, clientEmail);
  const { proposalId, token } = await draftAndSend(staff, catalog, eventId);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(staff.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(staff.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(staff.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  const { data: row } = await must(admin.from("contracts").select("content_sha256").eq("id", contractId).single());
  return { eventId, contractId, client, contentSha256: row!.content_sha256 };
}

const input = (contentSha256: string, overrides: Partial<SignInput> = {}): SignInput => ({
  typedName: "IT Client",
  consentAccepted: true,
  consentVersion: "demo-v1",
  contentSha256,
  signature: signaturePng(),
  ...overrides,
});

const sign = (c: Awaited<ReturnType<typeof sentContract>>, overrides: Partial<SignInput> = {}, extra: Partial<Parameters<typeof signContractAs>[0]> = {}) =>
  signContractAs({ userDb: c.client.db, userId: c.client.id, admin, slug: catalog.slug, contractId: c.contractId, input: input(c.contentSha256, overrides), request: REQUEST, ...extra });

async function objectsFor(contractId: string): Promise<string[]> {
  const { data } = await must(admin.from("contracts").select("tenant_id").eq("id", contractId).single());
  const { data: files } = await admin.storage.from(SIGNATURE_BUCKET).list(`${data!.tenant_id}/${contractId}`);
  return (files ?? []).map((f) => f.name);
}
const signatureRows = async (contractId: string) => (await must(admin.from("contract_signatures").select("*").eq("contract_id", contractId))).data!;
const statusOf = async (contractId: string) => (await must(admin.from("contracts").select("status").eq("id", contractId).single())).data!.status;

let otherTenantId: string | undefined;

describe("contract signing (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-sign-owner-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-sign");
    const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT agreement", p_title: "DEMO, NOT FOR CLIENT USE: IT", p_sections: SECTIONS }));
    const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    versionId = version!.id;
    await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
    const other = await signedInUser(admin, `it-sign-other-${randomUUID().slice(0, 8)}@example.test`);
    otherTenantId = (await createTenantWithCatalog(admin, other.id, "it-sign-b")).tenantId;
    otherStaff = other.db;
  });

  afterAll(async () => {
    if (admin) await archiveTestTenants(admin, catalog?.tenantId, otherTenantId);
  });

  it("stores a verified image first, then commits the evidence that references it", async () => {
    const c = await sentContract();
    const result = await sign(c, { typedName: "  IT   Client " });
    expect(result).toMatchObject({ status: "signed", replayed: false, typedName: "IT Client" });

    const [row] = await signatureRows(c.contractId);
    expect(row).toMatchObject({ signer_user_id: c.client.id, typed_name: "IT Client", content_sha256: c.contentSha256, client_ip: null, client_ip_source: "unavailable", user_agent: "IT Browser/1.0" });
    const { data: blob } = await admin.storage.from(SIGNATURE_BUCKET).download(row.signature_path);
    const bytes = Buffer.from(await blob!.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.signature_sha256);
    expect(bytes.length).toBe(row.signature_bytes);
    expect(await objectsFor(c.contractId)).toHaveLength(1);
    expect(await statusOf(c.contractId)).toBe("signed");
  });

  it("lets staff and the signer view the signature only through narrow, short-lived access", async () => {
    const c = await sentContract();
    await sign(c);
    const [row] = await signatureRows(c.contractId);

    // Staff of the tenant: a short-lived signed URL through the Storage policy.
    const { data: staffUrl } = await must(staff.storage.from(SIGNATURE_BUCKET).createSignedUrl(row.signature_path, 60));
    expect((await fetch(staffUrl!.signedUrl)).status).toBe(200);
    // Another tenant's staff, the client directly, and anon: nothing.
    expect((await otherStaff.storage.from(SIGNATURE_BUCKET).createSignedUrl(row.signature_path, 60)).error).toBeTruthy();
    expect((await c.client.db.storage.from(SIGNATURE_BUCKET).download(row.signature_path)).error).toBeTruthy();
    expect((await c.client.db.storage.from(SIGNATURE_BUCKET).list(row.signature_path.split("/").slice(0, 2).join("/"))).data ?? []).toEqual([]);
    const anon = createClient<Database>(localStatus().API_URL, localStatus().ANON_KEY, { auth: { persistSession: false } });
    expect((await anon.storage.from(SIGNATURE_BUCKET).download(row.signature_path)).error).toBeTruthy();
    // Nobody but the server writes: no overwrite, no upload, no delete.
    expect((await staff.storage.from(SIGNATURE_BUCKET).upload(row.signature_path, Buffer.from("x"), { upsert: true, contentType: "image/png" })).error).toBeTruthy();
    expect((await c.client.db.storage.from(SIGNATURE_BUCKET).upload(`${catalog.tenantId}/${c.contractId}/${randomUUID()}.png`, Buffer.from("x"), { contentType: "image/png" })).error).toBeTruthy();
    await staff.storage.from(SIGNATURE_BUCKET).remove([row.signature_path]);
    expect(await objectsFor(c.contractId)).toHaveLength(1);
    expect((await admin.storage.from(SIGNATURE_BUCKET).upload(row.signature_path, Buffer.from("x"), { contentType: "image/png", upsert: false })).error).toBeTruthy();

    // The signer: the path only through client_signature_object (the page signs it with the server key).
    expect((await must(c.client.db.rpc("client_signature_object", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }))).data).toBe(row.signature_path);
    expect((await must(staff.rpc("client_signature_object", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }))).data).toBeNull();
  });

  it("returns the existing signature to the signer after a lost response, without a second record", async () => {
    const c = await sentContract();
    const first = await sign(c);
    const retry = await sign(c, { typedName: "Someone Else", signature: signaturePng(40) });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await signatureRows(c.contractId)).toHaveLength(1);
    expect(await objectsFor(c.contractId)).toHaveLength(1);
    const { count } = await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("entity_id", c.contractId).eq("action", "signed");
    expect(count).toBe(1);
    // A replay that reaches the commit (bypassing the preflight) also keeps the first signature and removes its upload.
    const raced = await sign(c, {}, { userDb: { rpc: async () => ({ data: { state: "available", contract: { status: "sent", content_sha256: c.contentSha256 }, signing: { signed: false, enabled: true } }, error: null }) } as unknown as Db });
    expect(raced).toMatchObject({ status: "signed", replayed: true });
    expect(await objectsFor(c.contractId)).toHaveLength(1);
  });

  it("serializes concurrent attempts: one signature, one audit event, the rest are replays", async () => {
    const c = await sentContract();
    const results = await Promise.all([0, 10, 20, 30].map((seed) => sign(c, { signature: signaturePng(seed) })));
    expect(results.every((r) => r.status === "signed")).toBe(true);
    expect(results.filter((r) => r.status === "signed" && !r.replayed)).toHaveLength(1);
    expect(await signatureRows(c.contractId)).toHaveLength(1);
    const { count } = await admin.from("audit_events").select("id", { count: "exact", head: true }).eq("entity_id", c.contractId).eq("action", "signed");
    expect(count).toBe(1);
    // Losers' uploads are removed once the database answered "replayed".
    expect(await objectsFor(c.contractId)).toHaveLength(1);
  });

  it("refuses wrong signers and expired sessions before storing anything", async () => {
    const c = await sentContract();
    // Staff of the tenant, signed in, are not the signer.
    const asStaff = await signContractAs({ userDb: staff, userId: (await staff.auth.getUser()).data.user!.id, admin, slug: catalog.slug, contractId: c.contractId, input: input(c.contentSha256), request: REQUEST });
    expect(asStaff).toMatchObject({ status: "error", code: "unavailable" });
    // Another tenant's path for the same contract id.
    expect(await signContractAs({ userDb: c.client.db, userId: c.client.id, admin, slug: "it-sign-nope", contractId: c.contractId, input: input(c.contentSha256), request: REQUEST })).toMatchObject({ code: "unavailable" });
    // Even with the preflight bypassed, the transaction refuses a user id that is not the signer.
    const forged = await signContractAs({ userDb: c.client.db, userId: (await staff.auth.getUser()).data.user!.id, admin, slug: catalog.slug, contractId: c.contractId, input: input(c.contentSha256), request: REQUEST });
    expect(forged).toMatchObject({ status: "error", code: "unavailable" });
    // An expired session token.
    const env = JSON.parse(execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { API_URL: string; ANON_KEY: string; JWT_SECRET: string };
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: c.client.id, role: "authenticated", aud: "authenticated", iat: now - 7200, exp: now - 3600 })}`;
    const jwt = `${unsigned}.${createHmac("sha256", env.JWT_SECRET).update(unsigned).digest("base64url")}`;
    const expired = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    expect(await signContractAs({ userDb: expired, userId: c.client.id, admin, slug: catalog.slug, contractId: c.contractId, input: input(c.contentSha256), request: REQUEST })).toMatchObject({ code: "signed_out" });
    // A signed-out client.
    const signedOut = createClient<Database>(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    expect((await signContractAs({ userDb: signedOut, userId: c.client.id, admin, slug: catalog.slug, contractId: c.contractId, input: input(c.contentSha256), request: REQUEST })).status).toBe("error");

    expect(await objectsFor(c.contractId)).toHaveLength(0);
    expect(await signatureRows(c.contractId)).toHaveLength(0);
    expect(await statusOf(c.contractId)).toBe("sent");
  });

  it("validates consent, the displayed hash and the drawing before storing anything", async () => {
    const c = await sentContract();
    const blank = `data:image/png;base64,${encodeRgbaPng(Buffer.alloc(900 * 300 * 4), 900, 300).toString("base64")}`;
    const cases: [Partial<SignInput>, string][] = [
      [{ consentAccepted: false }, "consent_required"],
      [{ typedName: "  " }, "name_required"],
      [{ contentSha256: "0".repeat(64) }, "content_changed"],
      [{ signature: blank }, "signature_invalid"],
      [{ signature: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, "signature_invalid"],
      [{ signature: "data:image/png;base64,iVBORw0KGgo=" }, "signature_invalid"],
      [{ signature: `data:image/png;base64,${"A".repeat(400_000)}` }, "signature_invalid"],
      [{ consentVersion: "demo-v0" }, "consent_changed"],
    ];
    for (const [overrides, code] of cases) expect(await sign(c, overrides)).toMatchObject({ status: "error", code });
    expect(await objectsFor(c.contractId)).toHaveLength(0);
    expect(await signatureRows(c.contractId)).toHaveLength(0);
  });

  it("signs nothing when the upload fails", async () => {
    const c = await sentContract();
    const result = await sign(c, {}, { hooks: { upload: async () => ({ error: new Error("Simulated Storage outage (503)") }) } });
    expect(result).toMatchObject({ status: "error", code: "storage" });
    expect(await statusOf(c.contractId)).toBe("sent");
    expect(await signatureRows(c.contractId)).toHaveLength(0);
  });

  it("removes the upload when a void wins the race before the commit", async () => {
    const c = await sentContract();
    const result = await sign(c, {}, { hooks: { beforeCommit: async () => { await must(staff.rpc("void_contract", { p_contract_id: c.contractId, p_reason: "Wrong date" })); } } });
    expect(result).toMatchObject({ status: "error", code: "unavailable" });
    expect(await statusOf(c.contractId)).toBe("void");
    expect(await signatureRows(c.contractId)).toHaveLength(0);
    expect(await objectsFor(c.contractId)).toHaveLength(0);
  });

  it("removes the upload when a revised offer wins the race before the commit", async () => {
    const c = await sentContract();
    const result = await sign(c, {}, { hooks: { beforeCommit: async () => { await draftAndSend(staff, catalog, c.eventId); } } });
    expect(result).toMatchObject({ status: "error", code: "unavailable" });
    expect(await statusOf(c.contractId)).toBe("void");
    expect(await signatureRows(c.contractId)).toHaveLength(0);
    expect(await objectsFor(c.contractId)).toHaveLength(0);
  });

  it("leaves only an unreadable orphan when the server dies between upload and commit; a retry then signs", async () => {
    const c = await sentContract();
    await expect(sign(c, {}, { hooks: { beforeCommit: async () => { throw new Error("Simulated crash"); } } })).rejects.toThrow("Simulated crash");
    expect(await statusOf(c.contractId)).toBe("sent");
    const [orphan] = await objectsFor(c.contractId);
    expect(orphan).toBeTruthy();
    expect((await staff.storage.from(SIGNATURE_BUCKET).createSignedUrl(`${catalog.tenantId}/${c.contractId}/${orphan}`, 60)).error).toBeTruthy();

    expect(await sign(c)).toMatchObject({ status: "signed", replayed: false });
    const [row] = await signatureRows(c.contractId);
    expect(row.signature_path.endsWith(orphan)).toBe(false);
    expect(await objectsFor(c.contractId)).toHaveLength(2);
  });

  it("resolves a real race between signing and voiding to exactly one outcome", async () => {
    for (let i = 0; i < 3; i++) {
      const c = await sentContract();
      const [signed, voided] = await Promise.all([sign(c), staff.rpc("void_contract", { p_contract_id: c.contractId, p_reason: "Race" })]);
      const status = await statusOf(c.contractId);
      const rows = await signatureRows(c.contractId);
      if (status === "signed") {
        expect(signed).toMatchObject({ status: "signed", replayed: false });
        expect(voided.error?.message).toMatch(/only a sent, unsigned contract can be voided/);
        expect(rows).toHaveLength(1);
      } else {
        expect(status).toBe("void");
        expect(voided.error).toBeNull();
        expect(signed).toMatchObject({ status: "error", code: "unavailable" });
        expect(rows).toHaveLength(0);
        expect(await objectsFor(c.contractId)).toHaveLength(0);
      }
    }
  });

  it("keeps signed history readable by staff and the signer, and blocks revisions", async () => {
    const c = await sentContract();
    await sign(c);
    const { data: staffRows } = await must(staff.from("contract_signatures").select("typed_name, signer_email").eq("contract_id", c.contractId));
    expect(staffRows).toHaveLength(1);
    expect((await must(otherStaff.from("contract_signatures").select("id").eq("contract_id", c.contractId))).data).toEqual([]);
    expect((await must(c.client.db.from("contract_signatures").select("id").eq("contract_id", c.contractId))).data).toEqual([]);
    const { data: view } = await must(c.client.db.rpc("client_contract_view", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }));
    expect(view).toMatchObject({ state: "available", contract: { status: "signed" }, signing: { signed: true, typed_name: "IT Client" } });
    const { data: mine } = await must(c.client.db.rpc("my_contracts"));
    expect(mine!.find((m) => m.contract_id === c.contractId)).toMatchObject({ status: "signed" });

    const revision = await staff.rpc("open_proposal_draft", { p_event_id: c.eventId });
    expect(revision.error?.message).toMatch(/a contract has been signed for this event/);
    expect((await staff.rpc("void_contract", { p_contract_id: c.contractId, p_reason: "x" })).error?.message).toMatch(/this one is signed/);
  });
});
