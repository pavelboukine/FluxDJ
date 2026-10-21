import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubFacts } from "@/lib/client-event";
import type { HomeEvent } from "@/lib/client-home";
import { clientEditingSchema, type ClientEditing } from "@/lib/planning/cutoff";
import { progressPercent, progressSchema, type PlanProgress } from "@/lib/planning/view";
import type { ClientPaymentSummary } from "@/lib/payments";
import type { Database } from "@/lib/supabase/database.types";

/**
 * What a signed-in client may see about their events, for the client home
 * (/my) and each event's hub: one loader, so both always agree. Every fact
 * comes from client views that decide access in the database:
 *  - my_events: events with verified, unrevoked access (never archived or suspended);
 *  - my_contracts + client_contract_view + client_payment_summary: a contract and its
 *    payments, only for the contract's intended signer;
 *  - my_plans + client_planning_view: planning, only once the database allows it.
 * Nothing here decides access, booking or payment state.
 */

/** The frozen contract facts a client may read (client_contract_view, state "available"). */
export type ClientContractFacts = {
  id: string;
  status: "sent" | "signed";
  currency: string;
  totalCents: number;
  depositPercent: number;
  depositCents: number;
  balanceCents: number;
  balanceDueDate: string | null;
  signing:
    | { signed: true; signedAt: string; pdfReady: boolean; pdfPending: boolean }
    | { signed: false; enabled: boolean };
};

export type ClientEventFacts = {
  home: HomeEvent;
  /** Present only for the contract's intended signer. */
  contract: ClientContractFacts | null;
  payments: ClientPaymentSummary | null;
  /** Present only when the database lets this client open planning. */
  plan: { editing: ClientEditing | null; progress: PlanProgress | null } | null;
};

type Db = SupabaseClient<Database>;
type ContractViewRow = {
  state: string;
  contract?: { id: string; status: "sent" | "signed"; currency: string; total_cents: number; deposit_percent: number; deposit_cents: number; balance_cents: number; balance_due_date: string | null };
  signing?: { signed: boolean; enabled?: boolean; signed_at?: string; pdf_ready?: boolean; pdf_pending?: boolean };
};

/** Every event this client can open, or only `only` (one event of one business) when given. */
export async function loadClientEvents(supabase: Db, only?: { slug: string; eventId: string }): Promise<ClientEventFacts[]> {
  const [{ data: events }, { data: contracts }, { data: plans }] = await Promise.all([
    supabase.rpc("my_events"),
    supabase.rpc("my_contracts"),
    supabase.rpc("my_plans"),
  ]);
  const wanted = (slug: string, eventId: string | null) => !only || (slug === only.slug && eventId === only.eventId);

  // The newest readable contract per event (my_contracts is newest first; lower order wins whatever finishes first).
  const contractByEvent = new Map<string, { contract: ClientContractFacts; payments: ClientPaymentSummary | null; order: number }>();
  await Promise.all(
    (contracts ?? [])
      .filter((c) => c.event_id && wanted(c.tenant_slug, c.event_id))
      .map(async (c, order) => {
        const [{ data: view }, { data: summary }] = await Promise.all([
          supabase.rpc("client_contract_view", { p_contract_id: c.contract_id, p_tenant_slug: c.tenant_slug }),
          supabase.rpc("client_payment_summary", { p_contract_id: c.contract_id, p_tenant_slug: c.tenant_slug }),
        ]);
        const v = view as ContractViewRow | null;
        if (v?.state !== "available" || !v.contract || !v.signing) return;
        const existing = contractByEvent.get(c.event_id!);
        if (existing && existing.order < order) return;
        const k = v.contract;
        const facts: ClientContractFacts = {
          id: k.id,
          status: k.status,
          currency: k.currency,
          totalCents: k.total_cents,
          depositPercent: k.deposit_percent,
          depositCents: k.deposit_cents,
          balanceCents: k.balance_cents,
          balanceDueDate: k.balance_due_date,
          signing: v.signing.signed
            ? { signed: true, signedAt: v.signing.signed_at ?? "", pdfReady: v.signing.pdf_ready === true, pdfPending: v.signing.pdf_pending === true }
            : { signed: false, enabled: v.signing.enabled === true },
        };
        contractByEvent.set(c.event_id!, { contract: facts, payments: (summary as ClientPaymentSummary | null) ?? null, order });
      }),
  );

  // Planning the database lets this client open: whether editing is open, and progress.
  const planByEvent = new Map<string, NonNullable<ClientEventFacts["plan"]>>();
  await Promise.all(
    (plans ?? [])
      .filter((p) => wanted(p.tenant_slug, p.event_id))
      .map(async (p) => {
        const { data } = await supabase.rpc("client_planning_view", { p_event_id: p.event_id, p_tenant_slug: p.tenant_slug });
        const view = data as { state?: string; editing?: unknown; progress?: unknown } | null;
        if (view?.state !== "available") return;
        const editing = clientEditingSchema.safeParse(view.editing);
        const progress = progressSchema.safeParse(view.progress);
        planByEvent.set(p.event_id, { editing: editing.success ? editing.data : null, progress: progress.success ? progress.data : null });
      }),
  );

  return (events ?? [])
    .filter((e) => wanted(e.tenant_slug, e.event_id))
    .map((e) => {
      const c = contractByEvent.get(e.event_id);
      const plan = planByEvent.get(e.event_id) ?? null;
      const home: HomeEvent = {
        eventId: e.event_id,
        tenantSlug: e.tenant_slug,
        tenantName: e.tenant_display_name,
        title: e.title,
        eventDate: e.event_date,
        timezone: e.timezone,
        venueName: e.venue_name || null,
        lifecycle: e.lifecycle_status,
        bookingSource: e.booking_source,
        contract: c
          ? {
              id: c.contract.id,
              status: c.contract.status,
              signable: c.contract.signing.signed || c.contract.signing.enabled,
              pdfReady: c.contract.signing.signed && c.contract.signing.pdfReady,
              pdfPending: c.contract.signing.signed && c.contract.signing.pdfPending,
            }
          : null,
        payments: c?.payments
          ? { currency: c.payments.currency, bookingStatus: c.payments.booking_status, depositOutstandingCents: c.payments.deposit_outstanding_cents }
          : null,
        plan: plan ? { editing: plan.editing?.state ?? null } : null,
      };
      return { home, contract: c?.contract ?? null, payments: c?.payments ?? null, plan };
    });
}

/** What the hub's next step (and each event's card on /my) is worded from. */
export function hubFacts(f: ClientEventFacts): HubFacts {
  return {
    home: f.home,
    contract: f.contract
      ? { id: f.contract.id, status: f.contract.status, totalCents: f.contract.totalCents, signable: f.contract.signing.signed || f.contract.signing.enabled }
      : null,
    plan: f.plan ? { editing: f.plan.editing?.state ?? null, complete: f.plan.progress ? progressPercent(f.plan.progress) === 100 : false } : null,
  };
}
