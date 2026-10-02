/**
 * Storage API integration test for the private gear-media bucket.
 *
 * Runs against the LOCAL Supabase stack only (`pnpm db:start`). Users get real
 * sessions through the magic-link token flow (no passwords, no hand-made
 * JWTs), then exercise uploads, downloads, signed URLs, overwrites and deletes
 * through the real Storage HTTP API. All fixtures are removed afterwards.
 *
 * Run: pnpm test:integration
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type LocalStatus = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

function localStatus(): LocalStatus {
  const raw = execFileSync("node_modules/.bin/supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const status = JSON.parse(raw) as LocalStatus;
  const host = new URL(status.API_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run integration tests against non-local Supabase: ${status.API_URL}`);
  }
  return status;
}

const BUCKET = "gear-media";
// Minimal JPEG header bytes; enough for an upload with an image/jpeg type.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const run = randomUUID().slice(0, 8);
const ids = {
  tenantA: randomUUID(),
  tenantB: randomUUID(),
  gearA: randomUUID(),
  gearB: randomUUID(),
};
const pathA = `${ids.tenantA}/gear-items/${ids.gearA}/${randomUUID()}.jpg`;

let env: LocalStatus;
let admin: SupabaseClient;
let anon: SupabaseClient;
const users: Record<"ownerA" | "ownerB" | "client", { id: string; db: SupabaseClient }> = {} as never;

async function signedInClient(email: string): Promise<{ id: string; db: SupabaseClient }> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error) throw created.error;
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) throw link.error;

  const db = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await db.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error) throw verified.error;
  return { id: created.data.user.id, db };
}

async function must<T extends { error: unknown }>(p: PromiseLike<T>): Promise<T> {
  const result = await p;
  if (result.error) throw result.error;
  return result;
}

describe("gear-media Storage authorization (local Supabase)", () => {
  before(async () => {
    env = localStatus();
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, opts);
    anon = createClient(env.API_URL, env.ANON_KEY, opts);

    users.ownerA = await signedInClient(`it-owner-a-${run}@example.test`);
    users.ownerB = await signedInClient(`it-owner-b-${run}@example.test`);
    users.client = await signedInClient(`it-client-${run}@example.test`);

    await must(
      admin.from("tenants").insert([
        { id: ids.tenantA, slug: `it-a-${run}`, business_name: "IT A", display_name: "IT A" },
        { id: ids.tenantB, slug: `it-b-${run}`, business_name: "IT B", display_name: "IT B" },
      ]),
    );
    await must(
      admin.from("tenant_memberships").insert([
        { tenant_id: ids.tenantA, user_id: users.ownerA.id, role: "owner" },
        { tenant_id: ids.tenantB, user_id: users.ownerB.id, role: "owner" },
      ]),
    );
    await must(
      admin.from("gear_items").insert([
        { id: ids.gearA, tenant_id: ids.tenantA, key: "speaker", name: "Speaker", default_price_cents: 10000 },
        { id: ids.gearB, tenant_id: ids.tenantB, key: "speaker", name: "Speaker", default_price_cents: 10000 },
      ]),
    );
  });

  after(async () => {
    if (!admin) return;
    const { data: objects } = await admin.storage.from(BUCKET).list(`${ids.tenantA}/gear-items/${ids.gearA}`);
    const { data: objectsB } = await admin.storage.from(BUCKET).list(`${ids.tenantB}/gear-items/${ids.gearB}`);
    const paths = [
      ...(objects ?? []).map((o) => `${ids.tenantA}/gear-items/${ids.gearA}/${o.name}`),
      ...(objectsB ?? []).map((o) => `${ids.tenantB}/gear-items/${ids.gearB}/${o.name}`),
    ];
    if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    await admin.from("gear_items").delete().in("tenant_id", [ids.tenantA, ids.tenantB]);
    await admin.from("tenant_memberships").delete().in("tenant_id", [ids.tenantA, ids.tenantB]);
    await admin.from("tenants").delete().in("id", [ids.tenantA, ids.tenantB]);
    for (const u of Object.values(users)) await admin.auth.admin.deleteUser(u.id);
  });

  it("lets staff upload into their own tenant's gear item and read it back", async () => {
    await must(users.ownerA.db.storage.from(BUCKET).upload(pathA, JPEG_BYTES, { contentType: "image/jpeg" }));
    const { data } = await must(users.ownerA.db.storage.from(BUCKET).download(pathA));
    assert.deepEqual(new Uint8Array(await data!.arrayBuffer()), JPEG_BYTES);
  });

  it("issues a working short-lived signed URL only to authorized staff", async () => {
    const { data } = await must(users.ownerA.db.storage.from(BUCKET).createSignedUrl(pathA, 60));
    const response = await fetch(data!.signedUrl);
    assert.equal(response.status, 200);

    const other = await users.ownerB.db.storage.from(BUCKET).createSignedUrl(pathA, 60);
    assert.ok(other.error, "tenant B owner must not get a signed URL for tenant A media");
  });

  it("denies cross-tenant reads", async () => {
    const result = await users.ownerB.db.storage.from(BUCKET).download(pathA);
    assert.ok(result.error, "tenant B owner must not download tenant A media");
    const listed = await users.ownerB.db.storage.from(BUCKET).list(`${ids.tenantA}/gear-items/${ids.gearA}`);
    assert.deepEqual(listed.data ?? [], []);
  });

  it("denies cross-tenant uploads, including under another tenant's gear with own prefix", async () => {
    const intoA = await users.ownerB.db.storage
      .from(BUCKET)
      .upload(`${ids.tenantA}/gear-items/${ids.gearA}/${randomUUID()}.jpg`, JPEG_BYTES, { contentType: "image/jpeg" });
    assert.ok(intoA.error, "tenant B owner must not upload into tenant A");

    const mixed = await users.ownerB.db.storage
      .from(BUCKET)
      .upload(`${ids.tenantB}/gear-items/${ids.gearA}/${randomUUID()}.jpg`, JPEG_BYTES, { contentType: "image/jpeg" });
    assert.ok(mixed.error, "tenant B owner must not attach media to tenant A gear");
  });

  it("never overwrites an existing object, with or without upsert", async () => {
    const replacement = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const plain = await users.ownerA.db.storage.from(BUCKET).upload(pathA, replacement, { contentType: "image/jpeg" });
    assert.ok(plain.error, "re-upload to an existing path must fail");
    const upsert = await users.ownerA.db.storage
      .from(BUCKET)
      .upload(pathA, replacement, { contentType: "image/jpeg", upsert: true });
    assert.ok(upsert.error, "upsert must fail (no update policy)");

    const { data } = await must(admin.storage.from(BUCKET).download(pathA));
    assert.deepEqual(new Uint8Array(await data!.arrayBuffer()), JPEG_BYTES, "original bytes are intact");
  });

  it("does not let staff or other tenants delete media", async () => {
    const own = await users.ownerA.db.storage.from(BUCKET).remove([pathA]);
    assert.deepEqual(own.data ?? [], [], "owner A delete removes nothing");
    const other = await users.ownerB.db.storage.from(BUCKET).remove([pathA]);
    assert.deepEqual(other.data ?? [], [], "owner B delete removes nothing");
    await must(admin.storage.from(BUCKET).download(pathA));
  });

  it("rejects unsupported content types and names that are not random UUIDs", async () => {
    const html = await users.ownerA.db.storage
      .from(BUCKET)
      .upload(`${ids.tenantA}/gear-items/${ids.gearA}/${randomUUID()}.jpg`, JPEG_BYTES, { contentType: "text/html" });
    assert.ok(html.error, "text/html is not an allowed MIME type");
    const named = await users.ownerA.db.storage
      .from(BUCKET)
      .upload(`${ids.tenantA}/gear-items/${ids.gearA}/speaker.jpg`, JPEG_BYTES, { contentType: "image/jpeg" });
    assert.ok(named.error, "chosen filenames are rejected");
  });

  it("gives clients without membership no access", async () => {
    const read = await users.client.db.storage.from(BUCKET).download(pathA);
    assert.ok(read.error);
    const write = await users.client.db.storage
      .from(BUCKET)
      .upload(`${ids.tenantA}/gear-items/${ids.gearA}/${randomUUID()}.jpg`, JPEG_BYTES, { contentType: "image/jpeg" });
    assert.ok(write.error);
  });

  it("gives anonymous users no access, and the bucket has no public URLs", async () => {
    const read = await anon.storage.from(BUCKET).download(pathA);
    assert.ok(read.error);
    const write = await anon.storage
      .from(BUCKET)
      .upload(`${ids.tenantA}/gear-items/${ids.gearA}/${randomUUID()}.jpg`, JPEG_BYTES, { contentType: "image/jpeg" });
    assert.ok(write.error);
    const publicUrl = anon.storage.from(BUCKET).getPublicUrl(pathA).data.publicUrl;
    const response = await fetch(publicUrl);
    assert.notEqual(response.status, 200, "private bucket must not serve public URLs");
  });
});
