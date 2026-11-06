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

/**
 * A contract's money, frozen on it: stated figures (a genuine zero is 0), or
 * none at all (every column null, only on a direct contract). Comparing
 * total_cents with null narrows one from the other, so a figure can't be read
 * from a contract without any.
 */
type StatedMoney = { total_cents: number; deposit_percent: number | null; deposit_cents: number; balance_cents: number; balance_due_date: string | null };
type NoMoney = { total_cents: null; deposit_percent: null; deposit_cents: null; balance_cents: null; balance_due_date: null };
// One object rather than a union, so a failure still names the field (the log carries field paths, never values).
const contractMoney = z
  .object({
    total_cents: centsSchema.nullable(),
    // A direct contract may state an amount rather than a percentage.
    deposit_percent: depositPercent.nullable(),
    deposit_cents: centsSchema.nullable(),
    balance_cents: centsSchema.nullable(),
    balance_due_date: dateSchema.nullable(),
  })
  .refine(
    (t) =>
      t.total_cents === null
        ? t.deposit_cents === null && t.balance_cents === null && t.deposit_percent === null && t.balance_due_date === null
        : t.deposit_cents !== null && t.balance_cents !== null && t.deposit_cents + t.balance_cents === t.total_cents,
    "deposit and balance don't add up to the total",
  )
  .transform((t) => t as StatedMoney | NoMoney);

/** Present only on a contract with no proposal. Anything else must have complete terms, or it is not a contract. */
const contractSource = z.literal("direct").optional();
const proposalBackedIsComplete = (c: { source?: "direct"; total_cents: number | null; deposit_percent: number | null }) =>
  c.source === "direct" || (c.total_cents !== null && c.deposit_percent !== null);
const INCOMPLETE = "a proposal-backed contract needs its complete terms";

/** A contract's terms for display: never a figure for a contract without any. */
export type ContractTerms =
  | { financialTerms: "none"; currency: string }
  | {
      financialTerms: "stated";
      currency: string;
      /** Direct contracts state a total; only an approved selection itemizes taxes. */
      direct: boolean;
      totalCents: number;
      depositPercent: number | null;
      depositCents: number;
      balanceCents: number;
      balanceDueDate: string | null;
    };

export function contractTerms(c: { currency: string; source?: "direct" } & (StatedMoney | NoMoney)): ContractTerms {
  if (c.total_cents === null) return { financialTerms: "none", currency: c.currency };
  return {
    financialTerms: "stated",
    currency: c.currency,
    direct: c.source === "direct",
    totalCents: c.total_cents,
    depositPercent: c.deposit_percent,
    depositCents: c.deposit_cents,
    balanceCents: c.balance_cents,
    balanceDueDate: c.balance_due_date,
  };
}

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
          source: contractSource,
          currency: currencySchema,
          signing_mode: z.enum(["demo", "client_use", "none"]),
          event_title: z.string(),
          event_date: z.string(),
          legal_name: z.string(),
        })
        .and(contractMoney)
        .refine(proposalBackedIsComplete, INCOMPLETE),
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
    source: contractSource,
    currency: currencySchema,
    content_sha256: sha256Schema,
  })
  .and(contractMoney)
  .refine(proposalBackedIsComplete, INCOMPLETE)
  .refine((r) => r.eligible === (r.problems.length === 0), "eligibility doesn't match the problems");

/** public.generate_contract_draft's outcomes. */
export const generateContractResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["created", "replayed", "draft_exists"]), contract_id: idSchema }),
  z.object({ status: z.literal("incomplete"), missing: z.array(z.object({ key: z.string(), label: z.string(), hint: z.string() })) }),
  z.object({ status: z.literal("conflict"), contract_id: idSchema.nullable() }),
]);

/** public.generate_direct_contract_draft's outcomes: the same, or an owner must ask to go below the required deposit. */
export const generateDirectContractResultSchema = z.union([
  generateContractResultSchema,
  z.object({ status: z.literal("override_required"), deposit_percent: depositPercent, required_deposit_cents: centsSchema.nullable() }),
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
