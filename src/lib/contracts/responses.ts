import { z } from "zod";
import { centsSchema, currencySchema, dateSchema, idSchema, sha256Schema, timestampSchema } from "@/lib/db-response";
import { offerSnapshotSchema } from "@/lib/pricing/offer-snapshot";
import { selectionRecordSchema } from "@/lib/pricing/selection-record";

/**
 * Contract responses from the database, validated before a page shows their
 * figures or the signing flow acts on them (see lib/db-response.ts). Each
 * mirrors one function's jsonb_build_object; the refinements are invariants
 * the contracts table guarantees (deposit + balance = total, the signed
 * state and its signature), so a response that breaks one is not a contract.
 */

const depositPercent = z.int().min(0).max(100);
const addsUp = (t: { total_cents: number; deposit_cents: number; balance_cents: number }) => t.deposit_cents + t.balance_cents === t.total_cents;

/** public.client_contract_view: the signer's contract, or unavailable (no reason given). */
export const clientContractViewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }),
  z
    .object({
      state: z.literal("available"),
      brand: z.object({
        display_name: z.string(),
        brand_colors: z.object({ primary: z.string().optional(), accent: z.string().optional() }),
      }),
      contract: z
        .object({
          id: idSchema,
          status: z.enum(["sent", "signed"]),
          sent_at: timestampSchema,
          content_sha256: sha256Schema,
          // Parsed by renderedContentSchema where it is shown.
          rendered_content: z.unknown(),
          signer_name: z.string(),
          currency: currencySchema,
          total_cents: centsSchema,
          deposit_percent: depositPercent,
          deposit_cents: centsSchema,
          balance_cents: centsSchema,
          balance_due_date: dateSchema.nullable(),
          signing_mode: z.enum(["demo", "client_use", "none"]),
          event_title: z.string(),
          event_date: z.string(),
          legal_name: z.string(),
        })
        .refine(addsUp, "deposit and balance don't add up to the total"),
      signing: z.discriminatedUnion("signed", [
        z.object({ signed: z.literal(true), typed_name: z.string().min(1), signed_at: timestampSchema, pdf_ready: z.boolean(), pdf_pending: z.boolean() }),
        z.object({ signed: z.literal(false), enabled: z.boolean(), consent_version: z.string().nullable(), consent_text: z.string().nullable() }),
      ]),
    })
    .refine((v) => (v.contract.status === "signed") === v.signing.signed, "the signing state doesn't match the contract status"),
]);

/** public.sign_contract: signed (or the signer's earlier signature, replayed), or a rejection with a client-safe message. */
export const signContractResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("signed"), replayed: z.boolean(), contract_id: idSchema, signed_at: timestampSchema, typed_name: z.string().min(1) }),
  z.object({ status: z.literal("rejected"), code: z.string().min(1), message: z.string().min(1) }),
]);

/** public.review_contract_for_send: what would be sent, and private.contract_send_problems. */
export const contractReviewSchema = z
  .object({
    contract_id: idSchema,
    status: z.string().min(1),
    sent_at: timestampSchema.nullable(),
    eligible: z.boolean(),
    problems: z.array(z.object({ code: z.string(), message: z.string() })),
    can_send: z.boolean(),
    send_unavailable_reason: z.string().nullable(),
    signer: z.object({ name: z.string(), email: z.string() }),
    // The frozen party snapshot's business: older contracts lack some fields.
    business: z.object({
      legal_name: z.string().nullish(),
      name: z.string().optional(),
      address: z.string().nullish(),
      contact_email: z.string().nullish(),
      display_name: z.string().optional(),
    }),
    deposit_percent: depositPercent,
    deposit_cents: centsSchema,
    balance_cents: centsSchema,
    total_cents: centsSchema,
    currency: currencySchema,
    balance_due_date: dateSchema.nullable(),
    content_sha256: sha256Schema,
  })
  .refine(addsUp, "deposit and balance don't add up to the total")
  .refine((r) => r.eligible === (r.problems.length === 0), "eligibility doesn't match the problems");

/** public.generate_contract_draft's outcomes. */
export const generateContractResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["created", "replayed", "draft_exists"]), contract_id: idSchema }),
  z.object({ status: z.literal("incomplete"), missing: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string() })) }),
  z.object({ status: z.literal("conflict"), contract_id: idSchema.nullable() }),
]);

/**
 * public.client_approved_offer: the frozen offer and the stored selection the
 * contract was built from. The selection must have been priced against this
 * offer (its hash) in its currency, as the database checked when it was
 * submitted.
 */
export const approvedOfferSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unavailable") }),
  z
    .object({
      state: z.literal("available"),
      event_id: idSchema,
      contract: z.object({ id: idSchema, status: z.enum(["sent", "signed"]) }),
      proposal: z.object({ revision: z.int().min(1), offer_sha256: sha256Schema, offer: offerSnapshotSchema }),
      selection: z.object({ version: z.int().min(1), submitted_at: timestampSchema.nullable(), priced: selectionRecordSchema }),
      approved_at: timestampSchema,
    })
    .refine((a) => a.selection.priced.offer_sha256 === a.proposal.offer_sha256, "the selection was priced against another offer")
    .refine((a) => a.selection.priced.currency === a.proposal.offer.currency, "the selection's currency isn't the offer's"),
]);
