import type { Metadata } from "next";
import Link from "@/components/app/pending-link";
import { ActionForm } from "@/components/app/action-form";
import { Disclosure } from "@/components/app/disclosure";
import { CheckboxField, PageHeader } from "@/components/app/fields";
import { SetupReturn } from "@/components/app/setup-return";
import { requireStaff } from "@/lib/auth/staff";
import { saveBookingPolicy, saveProposalDefault } from "../../actions";
import { ReadOnlyRow, ReadOnlyRows, SettingsSection } from "../../settings-section";

export const metadata: Metadata = { title: "Bookings · Flux DJ" };

const WORKFLOWS: [string, string][] = [
  ["Proposal, then contract", "The client chooses a package and add-ons, you approve their choices, and they sign the contract. The confirmation policy below then decides when the booking is confirmed."],
  ["Contract only", "You skip the proposal and send a contract directly. If it has a deposit, the booking is confirmed when payments reach it; if not, when the client signs. If your policy requires a deposit, staff must meet it, and only the owner can make an exception."],
  ["Planning only", "The event was booked elsewhere, such as through an agency, so there is no proposal, contract or deposit, and Flux DJ records no payments for it. You set up planning and invite the client."],
];

export default async function BookingSettings({ params, searchParams }: PageProps<"/staff/[tenant]/settings/bookings">) {
  const { tenant: slug } = await params;
  const { from } = await searchParams;
  const { supabase, tenant, membership } = await requireStaff(slug);
  const { data: settings } = await supabase
    .from("tenants")
    .select("deposit_percent, booking_confirmation_policy, booking_policy_version, proposals_by_default")
    .eq("id", tenant.id)
    .single();
  const isOwner = membership.role === "owner";
  const onSignature = settings?.booking_confirmation_policy === "on_signature";

  return (
    <>
      <SetupReturn slug={slug} from={from} />
      <PageHeader title="Bookings" description="How new events start, and when Flux DJ confirms a booking." />

      <Disclosure id="booking-workflows" summary="How booking works" className="max-w-2xl">
        <div className="grid gap-3 text-sm" data-testid="booking-workflows">
          <p>You choose one of these for each event when you create it.</p>
          <dl className="grid gap-3">
            {WORKFLOWS.map(([title, text]) => (
              <div key={title} className="grid gap-0.5">
                <dt className="font-medium">{title}</dt>
                <dd className="text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
          <p className="text-muted-foreground">
            Flux DJ doesn&apos;t take payments: you record them on the event page. Planning opens to the client once the event is booked and you&apos;ve set it up.
          </p>
        </div>
      </Disclosure>

      <SettingsSection id="proposal-default" title="New events" data-testid="proposal-default">
        {isOwner ? (
          <ActionForm action={saveProposalDefault.bind(null, slug)} submitLabel="Save changes" trackUnsaved>
            <CheckboxField
              label="Send proposals by default"
              name="proposals_by_default"
              defaultChecked={settings?.proposals_by_default ?? true}
              hint="Start new events with the proposal step enabled. You can still change this for each event."
            />
          </ActionForm>
        ) : (
          <ReadOnlyRows>
            <ReadOnlyRow label="New events start" hint="You can change this for each event. Only the owner can change the default.">
              {settings?.proposals_by_default === false ? "Without a proposal" : "With a proposal"}
            </ReadOnlyRow>
          </ReadOnlyRows>
        )}
      </SettingsSection>

      <SettingsSection
        id="booking"
        title="Booking confirmation"
        description="Flux DJ confirms a booking automatically when this policy is met, and emails the client. Each contract keeps the policy it was generated with, so a change applies only to new contracts."
      >
        {isOwner ? (
          <ActionForm action={saveBookingPolicy.bind(null, slug)} version={settings?.booking_policy_version ?? 0} submitLabel="Save changes" trackUnsaved>
            <fieldset className="grid gap-3 text-sm">
              <legend className="mb-2 font-medium">Confirm a booking when…</legend>
              <label className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 md:min-h-0">
                <input type="radio" name="booking_policy" value="on_deposit" defaultChecked={!onSignature} className="mt-0.5 size-4 accent-primary" />
                <span className="font-medium">the contract is signed and the deposit is received (recommended)</span>
                <span className="col-start-2 text-xs text-muted-foreground">
                  Checked when the client signs and whenever you record or invalidate a payment. Payments recorded before signing count, and a 0% deposit means signing is enough.
                </span>
              </label>
              <label className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 md:min-h-0">
                <input type="radio" name="booking_policy" value="on_signature" defaultChecked={onSignature} className="mt-0.5 size-4 accent-primary" />
                <span className="font-medium">the contract is signed</span>
                <span className="col-start-2 text-xs text-muted-foreground">The deposit and balance may still be outstanding.</span>
              </label>
            </fieldset>
          </ActionForm>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Only the owner can change this.</p>
            <ReadOnlyRows>
              <ReadOnlyRow label="Bookings are confirmed when">
                {onSignature ? "the contract is signed." : "the contract is signed and the deposit is received."}
              </ReadOnlyRow>
            </ReadOnlyRows>
          </>
        )}
        <p data-testid="deposit-summary" className="text-sm">
          <span className="text-muted-foreground">Deposit due on signing: </span>
          <span className="font-medium">{settings?.deposit_percent}%</span>
          {" · "}
          <Link className="tap-target-y text-muted-foreground underline underline-offset-4 hover:text-foreground" href={`/staff/${slug}/settings/taxes#deposit`}>
            {isOwner ? "Change it in Taxes & payments" : "Set in Taxes & payments"}
          </Link>
        </p>
        <p className="text-xs text-muted-foreground">A recorded payment correction never cancels a booking; the event page warns you if the deposit is no longer covered.</p>
      </SettingsSection>
    </>
  );
}
