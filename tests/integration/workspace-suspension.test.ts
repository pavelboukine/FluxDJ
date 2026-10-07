/**
 * Workspace suspension against the LOCAL stack: real sessions racing the
 * suspension, the real PDF and email workers, and real Storage requests.
 * Dedicated test tenants; the operator is granted through the same SQL
 * function as the hosted one-time grant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { DOCUMENT_BUCKET, processDocumentJobs } from "@/lib/contracts/documents.server";
import { processOutbox } from "@/lib/email/outbox.server";
import type { EmailMessage, EmailTransport } from "@/lib/email/transport.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import {
  adminClient,
  archiveTestTenants,
  bothSeparate,
  createEvent,
  createTenantWithCatalog,
  draftAndSend,
  must,
  openLink,
  signedInUser,
  submit,
  type Catalog,
  type Db,
} from "./support/fixtures";
import { sqlInBackground, uuid } from "./support/sql";
import { grantPlatformAdminLocally, revokePlatformAdminLocally } from "../support/platform-admin";

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.messages.push(message);
    return { id: `rec-${this.messages.length}` };
  }
}

const run = randomUUID().slice(0, 8);
const operatorEmail = `it-susp-op-${run}@example.test`;
let admin: Db;
let operator: Db;
let owner: { id: string; db: Db };
let catalog: Catalog;
let other: Catalog;
let versionId: string;

const version = async (tenantId: string) =>
  (await must(admin.from("tenants").select("suspension_version").eq("id", tenantId).single())).data!.suspension_version;
const suspend = async (tenantId: string, reason = "Integration test suspension") =>
  operator.rpc("suspend_workspace", { p_tenant_id: tenantId, p_expected_version: await version(tenantId), p_reason: reason });
const restore = async (tenantId: string) =>
  operator.rpc("restore_workspace", { p_tenant_id: tenantId, p_expected_version: await version(tenantId), p_reason: "Integration test restore" });

function signaturePng(): string {
  const w = 600, h = 200;
  const rgba = Buffer.alloc(w * h * 4);
  for (let x = 100; x < 500; x++) for (let dy = -1; dy <= 1; dy++) {
    const i = ((100 + dy + Math.round(Math.sin(x / 15) * 40)) * w + x) * 4;
    rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
  }
  return `data:image/png;base64,${encodeRgbaPng(rgba, w, h).toString("base64")}`;
}

/** A contract signed through the real path, with its PDF job pending. */
async function signedContract() {
  const clientEmail = `it-susp-client-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId } = await createEvent(admin, catalog, clientEmail);
  const { proposalId, token } = await draftAndSend(owner.db, catalog, eventId);
  const { sessionHash } = await openLink(admin, catalog.slug, token);
  const submitted = await submit(admin, { slug: catalog.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(owner.db.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(owner.db.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: versionId }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(owner.db.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: catalog.slug }));
  const { data: row } = await must(admin.from("contracts").select("content_sha256").eq("id", contractId).single());
  const signed = await signContractAs({
    userDb: client.db, userId: client.id, admin, slug: catalog.slug, contractId,
    input: { typedName: "Sam Client", consentAccepted: true, consentVersion: "demo-v1", contentSha256: row!.content_sha256, signature: signaturePng() },
    request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
  });
  expect(signed).toMatchObject({ status: "signed" });
  return { contractId, client };
}

beforeAll(async () => {
  admin = adminClient();
  operator = (await signedInUser(admin, operatorEmail)).db;
  grantPlatformAdminLocally(operatorEmail);
  owner = await signedInUser(admin, `it-susp-owner-${run}@example.test`);
  catalog = await createTenantWithCatalog(admin, owner.id, "it-susp");
  // The same owner also owns a second business, which must stay usable.
  other = await createTenantWithCatalog(admin, owner.id, "it-susp-b");
  await must(admin.from("tenants").update({ business_address: "1 Test St" }).eq("id", catalog.tenantId));
  const { data: templateId } = await must(owner.db.rpc("create_contract_template", {
    p_tenant_id: catalog.tenantId, p_name: "IT", p_title: "DEMO, NOT FOR CLIENT USE: Agreement",
    p_sections: [{ heading: "Parties", body: "{{business.legal_name}} and {{client.name}}." }],
  }));
  const { data: v } = await must(owner.db.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
  versionId = v!.id;
  await must(owner.db.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
});

afterAll(async () => {
  for (const tenantId of [catalog?.tenantId, other?.tenantId]) {
    if (tenantId && (await version(tenantId)) % 2 === 1) await restore(tenantId);
  }
  revokePlatformAdminLocally(operatorEmail);
  await archiveTestTenants(admin, catalog?.tenantId, other?.tenantId);
});

describe("workspace suspension (local Supabase)", () => {
  it("concurrent suspensions and restorations each take effect exactly once", async () => {
    const v = await version(catalog.tenantId);
    const suspensions = await Promise.all(
      Array.from({ length: 5 }, () => operator.rpc("suspend_workspace", { p_tenant_id: catalog.tenantId, p_expected_version: v, p_reason: "Concurrent" })),
    );
    expect(suspensions.map((r) => r.error)).toEqual([null, null, null, null, null]);
    expect(suspensions.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    const restorations = await Promise.all(
      Array.from({ length: 5 }, () => operator.rpc("restore_workspace", { p_tenant_id: catalog.tenantId, p_expected_version: v + 1, p_reason: "Concurrent" })),
    );
    expect(restorations.map((r) => r.error)).toEqual([null, null, null, null, null]);
    expect(restorations.filter((r) => (r.data as { replayed: boolean }).replayed === false)).toHaveLength(1);
    expect(await version(catalog.tenantId)).toBe(v + 2);
    const { data: audit } = await must(admin.from("platform_audit_events").select("action").eq("entity_id", catalog.tenantId).order("occurred_at"));
    expect(audit!.slice(-2).map((a) => a.action)).toEqual(["suspended", "restored"]);
  });

  it("a write already in progress finishes first; every later write is refused", async () => {
    const name = `In flight ${run}`;
    const inFlight = sqlInBackground(
      `begin; insert into public.clients (tenant_id, name, email) values (${uuid(catalog.tenantId)}, '${name}', 'inflight-${run}@example.test'); select pg_sleep(1.5); commit;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const started = Date.now();
    const { error } = await suspend(catalog.tenantId);
    expect(error).toBeNull();
    expect(Date.now() - started).toBeGreaterThan(700); // it waited for the open write
    await inFlight;
    const { data: rows } = await must(admin.from("clients").select("id").eq("name", name));
    expect(rows).toHaveLength(1);
    const later = await admin.from("clients").insert({ tenant_id: catalog.tenantId, name: "Too late", email: `late-${run}@example.test` });
    expect(later.error?.code).toBe("PT423");
    await must(restore(catalog.tenantId));
  });

  it("an owner of two businesses keeps the other one, its data and its Storage files", async () => {
    const png = Buffer.from(signaturePng().split(",")[1], "base64");
    const { data: gear } = await must(owner.db.from("gear_items").select("id").eq("tenant_id", catalog.tenantId).limit(1).single());
    const path = `${catalog.tenantId}/gear-items/${gear!.id}/${randomUUID()}.png`;
    await must(owner.db.storage.from("gear-media").upload(path, png, { contentType: "image/png" }));

    await must(suspend(catalog.tenantId));
    expect((await owner.db.from("events").select("id").eq("tenant_id", catalog.tenantId)).data).toEqual([]);
    expect((await owner.db.from("gear_items").select("id").eq("tenant_id", other.tenantId)).data!.length).toBeGreaterThan(0);
    const { data: mine } = await must(owner.db.rpc("my_workspaces"));
    expect(mine!.map((w) => [w.slug, w.suspended]).sort()).toEqual([[catalog.slug, true], [other.slug, false]].sort());

    expect((await owner.db.storage.from("gear-media").download(path)).error).not.toBeNull();
    expect((await owner.db.storage.from("gear-media").createSignedUrl(path, 60)).error).not.toBeNull();
    const upload = await owner.db.storage.from("gear-media").upload(`${catalog.tenantId}/gear-items/${gear!.id}/${randomUUID()}.png`, png, { contentType: "image/png" });
    expect(upload.error).not.toBeNull();
    const { data: otherGear } = await must(owner.db.from("gear_items").select("id").eq("tenant_id", other.tenantId).limit(1).single());
    await must(owner.db.storage.from("gear-media").upload(`${other.tenantId}/gear-items/${otherGear!.id}/${randomUUID()}.png`, png, { contentType: "image/png" }));

    await must(restore(catalog.tenantId));
    expect((await owner.db.storage.from("gear-media").download(path)).error).toBeNull();
  });

  it("a PDF finished during a suspension isn't committed or emailed, and resumes after restoration", async () => {
    const { contractId, client } = await signedContract();
    const outcome = await processDocumentJobs({
      admin, tenantId: catalog.tenantId, contractId, limit: 1,
      hooks: { beforeCommit: async () => { await must(suspend(catalog.tenantId)); } },
    });
    expect(outcome).toMatchObject({ claimed: 1, paused: 1, committed: 0, failed: 0 });
    const { data: job } = await must(admin.from("document_jobs").select("status, attempts").eq("contract_id", contractId).single());
    expect(job).toEqual({ status: "pending", attempts: 0 });
    expect((await admin.from("contract_documents").select("id").eq("contract_id", contractId)).data).toEqual([]);
    expect((await admin.storage.from(DOCUMENT_BUCKET).list(`${catalog.tenantId}/${contractId}`)).data).toEqual([]);
    expect((await admin.from("email_outbox").select("id").eq("entity_id", contractId).eq("event_type", "contract_signed_copy")).data).toEqual([]);
    expect(await processDocumentJobs({ admin, tenantId: catalog.tenantId, limit: 5 })).toMatchObject({ claimed: 0 });
    // The signer can't read or download anything meanwhile.
    expect((await client.db.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: catalog.slug })).data).toEqual({ state: "unavailable" });

    await must(restore(catalog.tenantId));
    expect(await processDocumentJobs({ admin, tenantId: catalog.tenantId, contractId, limit: 1 })).toMatchObject({ committed: 1 });
    const { data: signature } = await must(admin.from("contract_signatures").select("signed_at").eq("contract_id", contractId).single());
    expect(signature!.signed_at).toBeTruthy();
  });

  it("emails queued before a suspension are never sent, not even after restoration", async () => {
    const { eventId } = await createEvent(admin, catalog, `it-susp-mail-${randomUUID().slice(0, 8)}@example.test`);
    const { proposalId } = await draftAndSend(owner.db, catalog, eventId);
    const { data: queued } = await must(admin.from("email_outbox").select("id, status").eq("entity_id", proposalId));
    expect(queued!.map((q) => q.status)).toEqual(["pending"]);

    await must(suspend(catalog.tenantId));
    const mail = new RecordingTransport();
    await processOutbox({ transport: mail, tenantId: catalog.tenantId });
    await must(restore(catalog.tenantId));
    await processOutbox({ transport: mail, tenantId: catalog.tenantId });
    expect(mail.messages.filter((m) => m.subject.includes("proposal"))).toEqual([]);
    const { data: after } = await must(admin.from("email_outbox").select("status").eq("entity_id", proposalId));
    expect(after!.map((q) => q.status)).toEqual(["cancelled"]);
  });
});
