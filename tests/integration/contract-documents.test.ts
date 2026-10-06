/**
 * Signed-contract PDFs against the LOCAL stack: real rendering, real Storage
 * and the real outbox with a recording transport. Dedicated test tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { encodeRgbaPng } from "@/lib/contracts/signature-image.server";
import { signContractAs } from "@/lib/contracts/signing.server";
import { SIGNATURE_BUCKET } from "@/lib/contracts/signing";
import { DOCUMENT_BUCKET, IntegrityError, processContractPdfQuietly, processDocumentJobs, readVerifiedDocument } from "@/lib/contracts/documents.server";
import { processOutbox } from "@/lib/email/outbox.server";
import { ResendTransport, type EmailMessage, type EmailTransport } from "@/lib/email/transport.server";
import { contractInviteToken, sha256Hex } from "@/lib/proposals/tokens.server";
import { pdfPageTexts } from "../support/pdf";
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

const SECTIONS = [
  { heading: "Parties", body: "{{business.legal_name}}, {{business.address}}\nClient: {{client.name}} ({{client.email}})" },
  { heading: "Prix", body: "Total {{pricing.total}}. Dépôt ({{payment.deposit_percent}}) : {{payment.deposit}}." },
];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let admin: Db;
let staff: Db;
let catalog: Catalog;
let versionId: string;
let clientUseVersionId: string;
let otherStaff: Db;
let otherCatalog: Catalog;
let otherVersionId: string;

class RecordingTransport implements EmailTransport {
  readonly name = "recording";
  messages: EmailMessage[] = [];
  /** failOnce: idempotency keys (one per outbox row) whose first send fails. */
  constructor(private readonly failOnce: Set<string> = new Set()) {}
  async send(message: EmailMessage) {
    this.messages.push(message);
    if (message.idempotencyKey && this.failOnce.has(message.idempotencyKey)) {
      this.failOnce.delete(message.idempotencyKey);
      throw new Error("Simulated provider outage (503)");
    }
    return { id: `rec-${this.messages.length}` };
  }
}

function signaturePng(): string {
  const w = 900, h = 300;
  const rgba = Buffer.alloc(w * h * 4);
  for (let t = 0; t < 600; t++) {
    const x = 150 + t, y = Math.round(150 + Math.sin(t / 20) * 60);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * w + (x + dx)) * 4;
      rgba[i] = 17; rgba[i + 1] = 24; rgba[i + 2] = 39; rgba[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${encodeRgbaPng(rgba, w, h).toString("base64")}`;
}

/** A signed contract (real signing path, DEMO unless a client-use version is given) and its parties. */
async function signedContract(
  clientName = "Chloé Gagnon",
  use: { version: string; consent: string } = { version: versionId, consent: "demo-v1" },
  ctx: { catalog: Catalog; staff: Db } = { catalog, staff },
) {
  const { catalog: cat, staff: owner } = ctx;
  const clientEmail = `it-pdf-${randomUUID().slice(0, 8)}@example.test`;
  const { eventId, clientId } = await createEvent(admin, cat, clientEmail);
  await must(admin.from("clients").update({ name: clientName }).eq("id", clientId));
  const { proposalId, token } = await draftAndSend(owner, cat, eventId);
  const { sessionHash } = await openLink(admin, cat.slug, token);
  const submitted = await submit(admin, { slug: cat.slug, proposalId, sessionHash, draftVersion: 0, input: { package_key: "signature", answers: bothSeparate } });
  const { data: approval } = await must(owner.rpc("approve_proposal_selection", { p_proposal_id: proposalId, p_selection_id: submitted.selection_id as string }));
  const { data: generated } = await must(owner.rpc("generate_contract_draft", { p_approval_id: (approval as { approval_id: string }).approval_id, p_template_version_id: use.version }));
  const contractId = (generated as { contract_id: string }).contract_id;
  const linkId = randomUUID();
  await must(owner.rpc("send_contract", { p_contract_id: contractId, p_link_id: linkId, p_token_hash: sha256Hex(contractInviteToken(linkId)) }));
  const client = await signedInUser(admin, clientEmail);
  await must(client.db.rpc("accept_contract_invitation", { p_link_id: linkId, p_tenant_slug: cat.slug }));
  const { data: row } = await must(admin.from("contracts").select("content_sha256").eq("id", contractId).single());
  const signed = await signContractAs({
    userDb: client.db, userId: client.id, admin, slug: cat.slug, contractId,
    input: { typedName: clientName, consentAccepted: true, consentVersion: use.consent, contentSha256: row!.content_sha256, signature: signaturePng() },
    request: { userAgent: "IT Browser/1.0", ip: null, ipSource: "unavailable" },
  });
  expect(signed).toMatchObject({ status: "signed", contractId });
  return { eventId, clientId, contractId, client, clientEmail };
}

const docFor = async (contractId: string) =>
  (await must(admin.from("contract_documents").select("*").eq("contract_id", contractId).maybeSingle())).data;
const jobFor = async (contractId: string) =>
  (await must(admin.from("document_jobs").select("*").eq("contract_id", contractId).single())).data!;
const objectsFor = async (contractId: string) => {
  const { data } = await admin.storage.from(DOCUMENT_BUCKET).list(`${catalog.tenantId}/${contractId}`);
  return (data ?? []).map((f) => f.name);
};
const copiesFor = async (contractId: string) =>
  (await must(admin.from("email_outbox").select("id, recipient_email, status, attempts, last_error, payload").eq("entity_id", contractId).eq("event_type", "contract_signed_copy").order("recipient_email"))).data!;
// "Due" times are set a minute in the past: the Node and database clocks may differ slightly.
const past = () => new Date(Date.now() - 60_000).toISOString();
/** Makes the contract's job due now (skipping backoff), without touching anything else. */
const makeDue = (contractId: string) => admin.from("document_jobs").update({ next_attempt_at: past() }).eq("contract_id", contractId);
const run = (extra: Parameters<typeof processDocumentJobs>[0] = {}) => processDocumentJobs({ admin, tenantId: catalog.tenantId, limit: 10, ...extra });

describe("signed-contract PDFs (local Supabase)", () => {
  beforeAll(async () => {
    admin = adminClient();
    const owner = await signedInUser(admin, `it-pdf-owner-${randomUUID().slice(0, 8)}@example.test`);
    staff = owner.db;
    catalog = await createTenantWithCatalog(admin, owner.id, "it-pdf");
    await must(admin.from("tenants").update({ business_address: "1234, rue Saint-Joseph\nGatineau (Québec)  J8Y 0A1" }).eq("id", catalog.tenantId));
    const { data: templateId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT agreement", p_title: "DEMO, NOT FOR CLIENT USE: Contrat", p_sections: SECTIONS }));
    const { data: version } = await must(staff.from("contract_template_versions").select("id").eq("template_id", templateId!).single());
    versionId = version!.id;
    await must(staff.rpc("publish_contract_template_version", { p_version_id: versionId, p_expected_draft_version: 0, p_usage: "demo" }));
    // The owner's own agreement, published for client use.
    const { data: realId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT real agreement", p_title: "Contrat de services", p_sections: SECTIONS }));
    const { data: real } = await must(staff.from("contract_template_versions").select("id").eq("template_id", realId!).single());
    clientUseVersionId = real!.id;
    const { data: statement } = await must(staff.rpc("client_use_statement_current"));
    await must(staff.rpc("publish_contract_template_version", {
      p_version_id: clientUseVersionId, p_expected_draft_version: 0, p_usage: "client_use", p_client_use_statement_version: (statement as { version: string }).version,
    }));
    const other = await signedInUser(admin, `it-pdf-other-${randomUUID().slice(0, 8)}@example.test`);
    otherCatalog = await createTenantWithCatalog(admin, other.id, "it-pdf-b");
    otherStaff = other.db;
    await must(admin.from("tenants").update({ business_address: "2 Other St" }).eq("id", otherCatalog.tenantId));
    const { data: otherTemplate } = await must(otherStaff.rpc("create_contract_template", { p_tenant_id: otherCatalog.tenantId, p_name: "IT other", p_title: "DEMO, NOT FOR CLIENT USE: Other", p_sections: SECTIONS }));
    const { data: otherVersion } = await must(otherStaff.from("contract_template_versions").select("id").eq("template_id", otherTemplate!).single());
    otherVersionId = otherVersion!.id;
    // The previously deployed app's two-argument call (PostgREST named arguments).
    await must(otherStaff.rpc("publish_contract_template_version", { p_version_id: otherVersionId, p_expected_draft_version: 0 }));
  });

  afterAll(async () => {
    // Leave no backlog behind for other suites, then archive both tenants.
    if (admin && otherCatalog) await admin.from("document_jobs").update({ next_attempt_at: past() }).eq("tenant_id", otherCatalog.tenantId).eq("status", "pending");
    if (admin) await archiveTestTenants(admin, otherCatalog?.tenantId, catalog?.tenantId);
  });

  it("renders only the frozen contract and evidence, even after the source records change", async () => {
    const c = await signedContract("Chloé Gagnon");
    const { data: tenantBefore } = await must(admin.from("tenants").select("business_name").eq("id", catalog.tenantId).single());
    // Change every live source after signing, before the PDF is rendered.
    await must(admin.from("clients").update({ name: "Renamed Client", email: `renamed-${randomUUID().slice(0, 6)}@example.test` }).eq("id", c.clientId));
    await must(admin.from("events").update({ title: "Renamed event" }).eq("id", c.eventId));
    await must(admin.from("packages").update({ base_price_cents: 1 }).eq("tenant_id", catalog.tenantId));

    expect(await run()).toMatchObject({ committed: 1, failed: 0 });
    const doc = (await docFor(c.contractId))!;
    const bytes = await readVerifiedDocument(admin, doc);
    expect(sha(bytes)).toBe(doc.pdf_sha256);
    expect(bytes.length).toBe(doc.byte_size);
    const text = (await pdfPageTexts(bytes)).join(" ");
    expect(text).toContain("Chloé Gagnon");
    expect(text).toContain(tenantBefore!.business_name);
    expect(text).toContain("Gatineau (Québec) J8Y 0A1");
    expect(text).toContain("Dépôt (50%)");
    expect(text).toContain(doc.content_sha256);
    expect(text).not.toContain("Renamed Client");
    expect(text).not.toContain("Renamed event");
    expect(text).not.toContain("$0.01");
    expect(bytes.toString("latin1")).not.toContain(doc.pdf_sha256);

    // The commit queued one signed copy per party.
    const copies = await copiesFor(c.contractId);
    expect(copies.map((r) => (r.payload as { recipient_role: string }).recipient_role).sort()).toEqual(["business", "client"]);
  }, 120_000);

  it("keeps the signature when rendering fails, then recovers the same job", async () => {
    const c = await signedContract();
    expect(await run({ hooks: { render: async () => { throw new Error("Simulated renderer crash"); } } })).toMatchObject({ failed: 1 });
    const job = await jobFor(c.contractId);
    expect(job).toMatchObject({ status: "pending", attempts: 1, last_error: "Simulated renderer crash" });
    expect((await must(admin.from("contracts").select("status").eq("id", c.contractId).single())).data!.status).toBe("signed");
    expect(await must(admin.from("contract_signatures").select("id").eq("contract_id", c.contractId))).toMatchObject({ data: [expect.anything()] });
    expect(await copiesFor(c.contractId)).toHaveLength(0);

    await makeDue(c.contractId);
    expect(await run()).toMatchObject({ committed: 1 });
    expect(await jobFor(c.contractId)).toMatchObject({ status: "succeeded", attempts: 2, last_error: null });
  }, 120_000);

  it("retries after an upload failure", async () => {
    const c = await signedContract();
    expect(await run({ hooks: { upload: async () => ({ error: new Error("503") }) } })).toMatchObject({ failed: 1 });
    expect(await jobFor(c.contractId)).toMatchObject({ status: "pending", last_error: "The signed PDF could not be stored. It will be retried." });
    expect(await objectsFor(c.contractId)).toHaveLength(0);
    await makeDue(c.contractId);
    expect(await run()).toMatchObject({ committed: 1 });
  }, 120_000);

  it("recovers from a worker that dies after uploading: the lease expires and an orphan stays unreferenced", async () => {
    const c = await signedContract();
    // A dying worker never reports failure: its fail_document_job call is lost.
    const dying = new Proxy(admin, {
      get(target, prop, receiver) {
        if (prop === "rpc") return (fn: string, args: unknown) => (fn === "fail_document_job" ? Promise.resolve({ data: null, error: null }) : target.rpc(fn as never, args as never));
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    await run({ admin: dying, hooks: { beforeCommit: async () => { throw new Error("process killed"); } } });
    const stuck = await jobFor(c.contractId);
    expect(stuck.status).toBe("running");
    const [orphan] = await objectsFor(c.contractId);
    expect(orphan).toBeTruthy();
    expect(await docFor(c.contractId)).toBeNull();
    expect(await run()).toMatchObject({ claimed: 0 }); // still leased

    await must(admin.from("document_jobs").update({ locked_until: past() }).eq("contract_id", c.contractId));
    expect(await run()).toMatchObject({ committed: 1 });
    const doc = (await docFor(c.contractId))!;
    expect(doc.storage_path.endsWith(orphan)).toBe(false);
    expect((await objectsFor(c.contractId)).sort()).toEqual([orphan, doc.storage_path.split("/").pop()].sort());
    expect(await jobFor(c.contractId)).toMatchObject({ status: "succeeded", attempts: 2 });
  }, 120_000);

  it("selects one canonical PDF when a stale worker races a newer one, and reuses it on retry", async () => {
    const c = await signedContract();
    // Worker A uploads, then (before committing) loses its lease to worker B, which commits first.
    const resultA = await run({
      hooks: {
        beforeCommit: async () => {
          await must(admin.from("document_jobs").update({ locked_until: past() }).eq("contract_id", c.contractId));
          expect(await run()).toMatchObject({ committed: 1 });
        },
      },
    });
    expect(resultA).toMatchObject({ reused: 1 });
    const doc = (await docFor(c.contractId))!;
    expect(await objectsFor(c.contractId)).toEqual([doc.storage_path.split("/").pop()]);
    expect(await copiesFor(c.contractId)).toHaveLength(2);
    // A retry after success reuses the canonical PDF (nothing is due, nothing changes).
    expect(await run()).toMatchObject({ claimed: 0 });
    expect((await docFor(c.contractId))!.storage_path).toBe(doc.storage_path);

    // Three workers racing for a fresh job: one claims it, one PDF results.
    const d = await signedContract();
    const parallel = await Promise.all([run(), run(), run()]);
    expect(parallel.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(parallel.reduce((n, r) => n + r.committed, 0)).toBe(1);
    expect(await objectsFor(d.contractId)).toHaveLength(1);
  }, 120_000);

  it("fails visibly and permanently when the signature image no longer matches its hash", async () => {
    const c = await signedContract();
    const { data: sig } = await must(admin.from("contract_signatures").select("signature_path").eq("contract_id", c.contractId).single());
    const { data: blob } = await admin.storage.from(SIGNATURE_BUCKET).download(sig!.signature_path);
    const tampered = Buffer.from(await blob!.arrayBuffer());
    tampered[tampered.length - 20] ^= 0xff;
    await must(admin.storage.from(SIGNATURE_BUCKET).update(sig!.signature_path, tampered, { contentType: "image/png", upsert: true }));
    expect(await run()).toMatchObject({ failed: 1 });
    expect(await jobFor(c.contractId)).toMatchObject({ status: "failed", last_error: "The stored signature image does not match its recorded SHA-256. The PDF was not generated." });
    expect(await docFor(c.contractId)).toBeNull();
    expect((await must(admin.from("contracts").select("status").eq("id", c.contractId).single())).data!.status).toBe("signed");
  }, 120_000);

  it("emails the same committed PDF to both parties, retrying one recipient without resending the other", async () => {
    const c = await signedContract("Chloé Gagnon");
    await run();
    const doc = (await docFor(c.contractId))!;
    const { data: business } = await must(admin.from("tenants").select("contact_email").eq("id", catalog.tenantId).single());
    const queued = await copiesFor(c.contractId);
    const businessRow = queued.find((r) => (r.payload as { recipient_role: string }).recipient_role === "business")!;
    // Only this contract's business copy fails once (other contracts share the business address).
    const transport = new RecordingTransport(new Set([`flux-signed-copy-${businessRow.id}`]));
    await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });

    let copies = await copiesFor(c.contractId);
    const byRole = (role: string) => copies.find((r) => (r.payload as { recipient_role: string }).recipient_role === role)!;
    expect(byRole("client")).toMatchObject({ status: "sent", recipient_email: c.clientEmail });
    expect(byRole("business")).toMatchObject({ status: "pending", last_error: "Simulated provider outage (503)" });

    await must(admin.from("email_outbox").update({ next_attempt_at: past() }).eq("id", byRole("business").id));
    await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
    copies = await copiesFor(c.contractId);
    expect(byRole("business")).toMatchObject({ status: "sent" });

    const ids = new Set(copies.map((r) => `flux-signed-copy-${r.id}`));
    const mine = transport.messages.filter((m) => m.idempotencyKey && ids.has(m.idempotencyKey));
    expect(mine.filter((m) => m.to === c.clientEmail)).toHaveLength(1);
    expect(mine.filter((m) => m.to === business!.contact_email)).toHaveLength(2);
    for (const m of mine) {
      expect(m.attachments).toHaveLength(1);
      const [a] = m.attachments!;
      expect(a.contentType).toBe("application/pdf");
      expect(a.filename).toMatch(/^signed-contract-.*\.pdf$/);
      expect(sha(a.content)).toBe(doc.pdf_sha256);
      expect(m.idempotencyKey).toMatch(/^flux-signed-copy-/);
      expect(m.text).not.toMatch(/IT staff-only secret|booked|deposit (has been )?paid|signed-pdf|token/i);
      expect(m.text).toContain("signed electronically");
    }
    expect(mine.find((m) => m.to === c.clientEmail)!.text).toContain("Chloé Gagnon");
    expect(mine.find((m) => m.to === c.clientEmail)!.text).toContain("it is not a booking or payment confirmation");
    const stored = JSON.stringify(copies);
    expect(stored).not.toContain(doc.storage_path);
    expect(stored).not.toContain("base64");
  }, 120_000);

  it("signs a client-use contract with the client-v1 consent and renders it without DEMO labels", async () => {
    const c = await signedContract("Chloé Gagnon", { version: clientUseVersionId, consent: "client-v1" });
    const { data: evidence } = await must(admin.from("contract_signatures").select("consent_version, consent_text").eq("contract_id", c.contractId).single());
    expect(evidence!.consent_version).toBe("client-v1");
    expect(evidence!.consent_text).toContain("bind me to it as a handwritten signature would");
    expect(await run()).toMatchObject({ committed: 1 });
    const text = (await pdfPageTexts(await readVerifiedDocument(admin, (await docFor(c.contractId))!))).join(" ");
    expect(text).not.toMatch(/DEMO|NOT FOR CLIENT USE/);
    expect(text).toContain("Consent (client-v1)");
    expect(text).toContain("This document records the client's electronic signature only.");
  }, 120_000);

  it("retries a signed copy with the identical Resend request after Business settings change", async () => {
    const c = await signedContract();
    await run();
    const copies = await copiesFor(c.contractId);
    const keys = new Set(copies.map((r) => `flux-signed-copy-${r.id}`));
    const { data: before } = await must(admin.from("tenants").select("display_name, reply_to_email").eq("id", catalog.tenantId).single());

    // The real Resend adapter; only its HTTP call is answered here (nothing
    // leaves the machine). Every other request (Supabase) goes through.
    const requests: { key: string; headers: Record<string, string>; body: string }[] = [];
    let providerUp = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== "https://api.resend.com/emails") return realFetch(input, init);
      const headers = init!.headers as Record<string, string>;
      requests.push({ key: headers["Idempotency-Key"], headers, body: init!.body as string });
      return providerUp ? new Response(JSON.stringify({ id: `resend-${requests.length}` }), { status: 200 }) : new Response("{}", { status: 503 });
    }) as typeof fetch;
    try {
      const transport = new ResendTransport("re_test_not_a_real_key");
      await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
      const first = requests.filter((r) => keys.has(r.key));
      expect(first).toHaveLength(2);
      expect((await copiesFor(c.contractId)).every((r) => r.status === "pending")).toBe(true);

      // The business changes its sender details before the retry.
      await must(admin.from("tenants").update({ display_name: "Renamed Business", reply_to_email: "renamed@example.test" }).eq("id", catalog.tenantId));
      providerUp = true;
      await must(admin.from("email_outbox").update({ next_attempt_at: past() }).in("id", copies.map((r) => r.id)));
      await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });

      const all = requests.filter((r) => keys.has(r.key));
      expect(all).toHaveLength(4);
      for (const key of keys) {
        const [attempt1, attempt2] = all.filter((r) => r.key === key);
        // Same key, same headers, byte-for-byte the same body (sender, text and attachment).
        expect(attempt2.headers).toEqual(attempt1.headers);
        expect(attempt2.body).toBe(attempt1.body);
        const body = JSON.parse(attempt2.body) as { from: string; reply_to?: string; subject: string; text: string; attachments: { content: string }[] };
        expect(body.from).toMatch(new RegExp(`^${before!.display_name} via Flux DJ <`));
        expect(body.reply_to).toBe(before!.reply_to_email ?? undefined);
        expect(`${body.subject} ${body.text}`).not.toContain("Renamed Business");
        expect(body.attachments).toHaveLength(1);
      }
      const sent = await copiesFor(c.contractId);
      expect(sent.every((r) => r.status === "sent")).toBe(true);
      // The outbox holds the frozen sender, never attachment bytes, tokens or download URLs.
      const { data: stored } = await must(admin.from("email_outbox").select("payload, sender").in("id", copies.map((r) => r.id)));
      for (const row of stored!) expect(Object.keys(row.sender as object).sort()).toEqual(["display_name", "from_address", "from_name", "reply_to"]);
      expect(JSON.stringify(stored)).not.toMatch(/base64|JVBER|signed-pdf|token/i);
    } finally {
      globalThis.fetch = realFetch;
      await must(admin.from("tenants").update({ display_name: before!.display_name, reply_to_email: before!.reply_to_email }).eq("id", catalog.tenantId));
    }
  }, 120_000);

  it("the previously deployed app's two-argument publish keeps DEMO behaviour and never approves client use", async () => {
    const { data: v } = await must(admin.from("contract_template_versions").select("usage, client_use_confirmed_at").eq("id", otherVersionId).single());
    expect(v).toEqual({ usage: "demo", client_use_confirmed_at: null });
    const { data: realId } = await must(staff.rpc("create_contract_template", { p_tenant_id: catalog.tenantId, p_name: "IT old-app real", p_title: "Contrat réel", p_sections: SECTIONS }));
    const { data: real } = await must(staff.from("contract_template_versions").select("id").eq("template_id", realId!).single());
    const { error } = await staff.rpc("publish_contract_template_version", { p_version_id: real!.id, p_expected_draft_version: 0 });
    expect(error?.message).toMatch(/only DEMO agreements can be published this way/);
    expect((await must(admin.from("contract_template_versions").select("published_at, usage").eq("id", real!.id).single())).data).toEqual({ published_at: null, usage: null });
  });

  it("processes the just-signed contract's PDF right away, without draining another tenant's backlog", async () => {
    // Backlog: two signed contracts in another tenant, queued earlier and due.
    const backlog = [
      await signedContract("Backlog One", { version: otherVersionId, consent: "demo-v1" }, { catalog: otherCatalog, staff: otherStaff }),
      await signedContract("Backlog Two", { version: otherVersionId, consent: "demo-v1" }, { catalog: otherCatalog, staff: otherStaff }),
    ];
    await must(admin.from("document_jobs").update({ next_attempt_at: new Date(Date.now() - 3_600_000).toISOString() }).in("contract_id", backlog.map((b) => b.contractId)));

    const c = await signedContract();
    // What the signing action runs after the response, with the contract id from the database's answer.
    await processContractPdfQuietly(c.contractId);

    expect(await jobFor(c.contractId)).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await docFor(c.contractId)).not.toBeNull();
    expect(await copiesFor(c.contractId)).toHaveLength(2);
    for (const b of backlog) {
      expect(await jobFor(b.contractId)).toMatchObject({ status: "pending", attempts: 0 });
      expect(await docFor(b.contractId)).toBeNull();
    }
    // The scheduled worker still drains the backlog.
    expect(await processDocumentJobs({ admin, tenantId: otherCatalog.tenantId, limit: 10 })).toMatchObject({ committed: 2, failed: 0 });
  }, 180_000);

  it("an immediate worker racing the scheduled worker yields one canonical PDF and one email per recipient", async () => {
    const c = await signedContract();
    let cronResult: Awaited<ReturnType<typeof processDocumentJobs>> | null = null;
    // The immediate worker has rendered and uploaded; before it commits, its
    // lease runs out and the scheduled worker claims and commits the job.
    const immediate = await processDocumentJobs({
      admin,
      contractId: c.contractId,
      limit: 1,
      hooks: {
        beforeCommit: async () => {
          await must(admin.from("document_jobs").update({ locked_until: past() }).eq("contract_id", c.contractId));
          cronResult = await run();
        },
      },
    });
    expect(cronResult).toMatchObject({ committed: 1 });
    expect(immediate).toMatchObject({ claimed: 1, reused: 1, failed: 0 });
    expect((await must(admin.from("contract_documents").select("id").eq("contract_id", c.contractId))).data).toHaveLength(1);
    const doc = (await docFor(c.contractId))!;
    expect(await objectsFor(c.contractId)).toEqual([doc.storage_path.split("/").pop()]);
    const copies = await copiesFor(c.contractId);
    expect(copies.map((r) => r.recipient_email).sort()).toEqual([c.clientEmail, (await must(admin.from("tenants").select("contact_email").eq("id", catalog.tenantId).single())).data!.contact_email].sort());

    // Both at once, on a fresh contract: still one PDF and two email rows.
    const d = await signedContract();
    await Promise.all([processContractPdfQuietly(d.contractId), run()]);
    await processContractPdfQuietly(d.contractId);
    expect((await must(admin.from("contract_documents").select("id").eq("contract_id", d.contractId))).data).toHaveLength(1);
    expect(await copiesFor(d.contractId)).toHaveLength(2);
    expect(await jobFor(d.contractId)).toMatchObject({ status: "succeeded" });
  }, 180_000);

  it("a failed immediate attempt keeps the signature and is recovered by the scheduled worker", async () => {
    const c = await signedContract();
    expect(await processDocumentJobs({ admin, contractId: c.contractId, hooks: { render: async () => { throw new Error("Simulated crash right after signing"); } } }))
      .toMatchObject({ claimed: 1, failed: 1 });
    expect(await jobFor(c.contractId)).toMatchObject({ status: "pending", attempts: 1, last_error: "Simulated crash right after signing" });
    expect((await must(admin.from("contracts").select("status").eq("id", c.contractId).single())).data!.status).toBe("signed");
    expect(await copiesFor(c.contractId)).toHaveLength(0);
    await makeDue(c.contractId);
    expect(await run()).toMatchObject({ committed: 1 });
    expect(await jobFor(c.contractId)).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(await copiesFor(c.contractId)).toHaveLength(2);
  }, 180_000);

  it("never delivers or downloads a PDF whose stored bytes no longer match", async () => {
    const c = await signedContract();
    await run();
    const doc = (await docFor(c.contractId))!;
    const { data: blob } = await admin.storage.from(DOCUMENT_BUCKET).download(doc.storage_path);
    const tampered = Buffer.from(await blob!.arrayBuffer());
    tampered[200] ^= 0xff;
    await must(admin.storage.from(DOCUMENT_BUCKET).update(doc.storage_path, tampered, { contentType: "application/pdf", upsert: true }));

    await expect(readVerifiedDocument(admin, doc)).rejects.toBeInstanceOf(IntegrityError);
    const transport = new RecordingTransport();
    await processOutbox({ transport, tenantId: catalog.tenantId, limit: 50 });
    const copies = await copiesFor(c.contractId);
    const ids = new Set(copies.map((r) => `flux-signed-copy-${r.id}`));
    expect(transport.messages.filter((m) => m.idempotencyKey && ids.has(m.idempotencyKey))).toHaveLength(0);
    expect(copies.every((r) => r.status === "failed" && /does not match its recorded SHA-256/.test(r.last_error ?? ""))).toBe(true);
  }, 120_000);

  it("keeps documents private: no direct Storage reads, no cross-tenant records, signer-only references", async () => {
    const c = await signedContract();
    await run();
    const doc = (await docFor(c.contractId))!;
    const anon = createClient<Database>(localStatus().API_URL, localStatus().ANON_KEY, { auth: { persistSession: false } });
    for (const db of [staff, c.client.db, otherStaff, anon]) {
      expect((await db.storage.from(DOCUMENT_BUCKET).download(doc.storage_path)).error).toBeTruthy();
      expect((await db.storage.from(DOCUMENT_BUCKET).createSignedUrl(doc.storage_path, 60)).error).toBeTruthy();
      expect((await db.storage.from(DOCUMENT_BUCKET).upload(`${catalog.tenantId}/${c.contractId}/${randomUUID()}.pdf`, Buffer.from("%PDF-"), { contentType: "application/pdf" })).error).toBeTruthy();
    }
    expect((await must(staff.from("contract_documents").select("id").eq("contract_id", c.contractId))).data).toHaveLength(1);
    expect((await must(otherStaff.from("contract_documents").select("id").eq("contract_id", c.contractId))).data).toEqual([]);
    expect((await must(c.client.db.from("contract_documents").select("id").eq("contract_id", c.contractId))).data).toEqual([]);
    expect(((await must(c.client.db.rpc("client_signed_document", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }))).data as { storage_path: string }).storage_path).toBe(doc.storage_path);
    expect((await must(staff.rpc("client_signed_document", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug }))).data).toBeNull();
    expect((await anon.rpc("client_signed_document", { p_contract_id: c.contractId, p_tenant_slug: catalog.slug })).error).toBeTruthy();
  }, 120_000);
});
