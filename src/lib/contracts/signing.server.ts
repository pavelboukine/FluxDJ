import "server-only";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { decodeSignatureDataUrl, processSignatureImage } from "./signature-image.server";
import { MAX_SIGNATURE_DATA_URL_LENGTH, SIGNATURE_BUCKET, type SignInput, type SignResult } from "./signing";

type Db = SupabaseClient<Database>;

export type RequestEvidence = { userAgent: string | null; ip: string | null; ipSource: "vercel" | "unavailable" };

/**
 * The client IP, only when the platform guarantees it. On Vercel,
 * x-vercel-forwarded-for is set by Vercel itself (it overwrites forwarded-for
 * headers so clients cannot spoof them), and it stays correct even behind
 * another proxy. Anywhere else (local development, other hosts) the IP is
 * recorded as unavailable instead of trusting an arbitrary header.
 */
export function trustedClientIp(headers: Headers, env: Record<string, string | undefined> = process.env): Pick<RequestEvidence, "ip" | "ipSource"> {
  if (env.VERCEL !== "1") return { ip: null, ipSource: "unavailable" };
  const candidate = headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return isIP(candidate) ? { ip: candidate, ipSource: "vercel" } : { ip: null, ipSource: "unavailable" };
}

export function requestEvidence(headers: Headers, env?: Record<string, string | undefined>): RequestEvidence {
  const userAgent = headers.get("user-agent")?.trim().slice(0, 512) || null;
  return { userAgent, ...trustedClientIp(headers, env) };
}

const error = (code: string, message: string): SignResult => ({ status: "error", code, message });
const HASH_RE = /^[0-9a-f]{64}$/;

type Hooks = {
  /** Replaces the Storage upload (tests simulate outages). */
  upload?: (path: string, bytes: Buffer) => Promise<{ error: unknown }>;
  /** Runs between upload and commit (tests simulate races and crashes). */
  beforeCommit?: () => Promise<void>;
};

/**
 * Signs a contract for an Auth-validated user.
 *
 * `userDb` acts as the signed-in user (row-level security applies) and is
 * used for the read-only eligibility check; `userId` must come from
 * auth.getUser() on the server, never from the browser. `admin` stores the
 * image and runs the service-role-only sign_contract transaction.
 *
 * Ordering: validate -> eligibility -> upload to a fresh unique path ->
 * commit. If the database rejects the commit or returns a replay, the upload
 * is removed (best effort). When the outcome is unknown it is kept; anything
 * left behind unreferenced is an orphan.
 * Evidence is never logged.
 */
export async function signContractAs(opts: {
  userDb: Db;
  userId: string;
  admin: Db;
  slug: string;
  contractId: string;
  input: SignInput;
  request: RequestEvidence;
  hooks?: Hooks;
}): Promise<SignResult> {
  const { userDb, userId, admin, slug, contractId, input, request, hooks } = opts;

  const typedName = typeof input.typedName === "string" ? input.typedName.trim().replace(/\s+/g, " ") : "";
  if (typedName.length < 1 || typedName.length > 200) return error("name_required", "Type your full name (up to 200 characters).");
  if (input.consentAccepted !== true) return error("consent_required", "Check the box to confirm you agree to sign electronically.");
  if (typeof input.consentVersion !== "string" || input.consentVersion.length > 40) return error("consent_changed", "Reload the page and try again.");
  if (typeof input.contentSha256 !== "string" || !HASH_RE.test(input.contentSha256)) return error("content_changed", "Reload the page and try again.");
  if (typeof input.signature !== "string" || input.signature.length > MAX_SIGNATURE_DATA_URL_LENGTH) {
    return error("signature_invalid", "Your signature image is too large. Clear it and draw it again.");
  }
  const decoded = decodeSignatureDataUrl(input.signature);
  if (!decoded.ok) return error("signature_invalid", decoded.error.message);
  const processed = processSignatureImage(decoded.bytes);
  if (!processed.ok) return error("signature_invalid", processed.error.message);
  const image = processed.image;

  // Read-only eligibility as the user, before storing anything.
  const { data: viewData, error: viewError } = await userDb.rpc("client_contract_view", { p_contract_id: contractId, p_tenant_slug: slug });
  if (viewError) {
    // An expired or invalid session is refused by the API before any check runs.
    if (viewError.code === "PGRST301" || viewError.code === "PGRST303" || viewError.code === "42501") {
      return error("signed_out", "Your sign-in has expired. Sign in again to sign; your drawing is kept on this page.");
    }
    return error("network", "We couldn't check your contract. Nothing was signed. Try again.");
  }
  const view = viewData as {
    state: string;
    contract?: { status: string; content_sha256: string };
    signing?: { signed: boolean; enabled?: boolean; typed_name?: string; signed_at?: string };
  };
  if (view.state !== "available" || !view.contract) return error("unavailable", "This contract isn't available.");
  if (view.contract.status === "signed" && view.signing?.signed) {
    return { status: "signed", signedAt: view.signing.signed_at!, typedName: view.signing.typed_name!, replayed: true };
  }
  if (view.signing?.enabled === false) return error("signing_disabled", "Online signing isn't available for this contract yet.");
  if (view.contract.content_sha256 !== input.contentSha256) {
    return error("content_changed", "This contract is not the one you were shown. Reload the page and read it again before signing.");
  }

  // 1. Store the verified image under a path that has never been used.
  const { data: contractRow } = await admin.from("contracts").select("tenant_id").eq("id", contractId).single();
  if (!contractRow) return error("unavailable", "This contract isn't available.");
  const path = `${contractRow.tenant_id}/${contractId}/${randomUUID()}.png`;
  const upload =
    hooks?.upload ??
    (async (p: string, bytes: Buffer) => admin.storage.from(SIGNATURE_BUCKET).upload(p, bytes, { contentType: "image/png", upsert: false }));
  const uploaded = await upload(path, image.png).catch((e: unknown) => ({ error: e }));
  if (uploaded.error) return error("storage", "We couldn't save your signature. Nothing was signed. Try again.");

  const discardUpload = async () => {
    await admin.storage.from(SIGNATURE_BUCKET).remove([path]).catch(() => undefined);
  };

  // 2. One transaction: recheck everything, store the evidence, sign. If
  // this throws (a crash or simulated failure), the upload stays behind as an
  // unreferenced orphan; nothing is signed without a stored image.
  await hooks?.beforeCommit?.();
  const { data, error: rpcError } = await admin.rpc("sign_contract", {
    p_contract_id: contractId,
    p_tenant_slug: slug,
    p_user_id: userId,
    p_typed_name: typedName,
    p_content_sha256: input.contentSha256,
    p_consent_version: input.consentVersion,
    p_consent_accepted: true,
    p_signature_path: path,
    p_signature_sha256: image.sha256,
    p_signature_bytes: image.png.length,
    p_signature_width: image.width,
    p_signature_height: image.height,
    p_user_agent: request.userAgent ?? "",
    p_client_ip: request.ip ?? "",
    p_client_ip_source: request.ipSource,
  });
  if (rpcError) {
    // Outcome unknown (the commit may have succeeded before the response was
    // lost), so the upload is kept: a committed signature may reference it.
    // Retrying is safe: a committed signature comes back as a replay.
    return error("network", "We couldn't confirm your signature. Try again; you won't sign twice.");
  }
  const result = data as { status: string; code?: string; message?: string; signed_at?: string; typed_name?: string; replayed?: boolean };
  // Definitive answers: a rejection stored nothing, and a replay kept the
  // first signature, so this upload is unused either way.
  if (result.status !== "signed" || result.replayed) await discardUpload();
  if (result.status !== "signed") return error(result.code ?? "unavailable", result.message ?? "This contract isn't available.");
  return { status: "signed", signedAt: result.signed_at!, typedName: result.typed_name!, replayed: Boolean(result.replayed) };
}
