"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ActionForm } from "@/components/app/action-form";
import { Field, TextField, selectClass } from "@/components/app/fields";
import type { MissingItem } from "@/lib/contracts/content";
import { centsToInputValue, formatCents, parseMoneyToCents } from "@/lib/money";
import { PHONE_HINT, PHONE_MAX } from "@/lib/phone";
import { addClientPhone } from "../clients/actions";
import { generateContract, generateDirectContract, type GenerateResult } from "./actions";

type VersionOption = {
  id: string;
  label: string;
  needsBalanceDueDate: boolean;
  needsClientPhone?: boolean;
  /** Direct contracts only: the template has a field for the services, states money, states a deposit, or needs an approved proposal. */
  needsServices?: boolean;
  usesPayment?: boolean;
  statesDeposit?: boolean;
  needsProposal?: boolean;
};

/** A contract-first event: the terms are typed here, and the business's deposit rule decides who may go below it. */
export type DirectContractSetup = {
  eventId: string;
  currency: string;
  depositPercent: number;
  depositRequired: boolean;
  isOwner: boolean;
};

type Props = {
  slug: string;
  /** Exactly one of these: generate from the approved selection, or with no proposal. */
  approvalId?: string;
  direct?: DirectContractSetup;
  versions: VersionOption[];
  defaultVersionId: string | null;
  /** `balanceDueDate`: the date the current draft was generated with (kept when regenerating unless changed). */
  currentDraft: { id: string; label: string; signable: boolean; balanceDueDate?: string | null; totalCents?: number | null; depositCents?: number | null; services?: string | null } | null;
  /** The event date, unless it has passed: the default remaining-balance due date for a new draft. */
  suggestedBalanceDueDate?: string | null;
  /** Active versions published before usage modes, left out of the list. */
  legacyHidden: number;
  /** The event's active signer: a missing phone a template needs can be added right here. */
  signer?: { clientId: string; name: string; phone: string | null } | null;
  /** Details edited since the current draft was generated (it keeps the old ones until regenerated). */
  changes?: string[];
};

/**
 * Generates the contract draft for an approved proposal. Replacing an
 * existing draft always needs an explicit confirmation. The server makes
 * repeated clicks safe: an identical request returns the existing draft.
 *
 * The remaining-balance due date starts as the current draft's own date
 * (so regenerating never silently changes it), else the event date; staff
 * can change it, and the server validates it. The deposit is separate: it is
 * due on signing, as the business's settings say.
 */
export function GenerateContractPanel({ slug, approvalId, direct, versions, defaultVersionId, currentDraft, suggestedBalanceDueDate = null, legacyHidden, signer = null, changes = [] }: Props) {
  const router = useRouter();
  const [versionId, setVersionId] = useState(defaultVersionId ?? versions[0]?.id ?? "");
  const draftDueDate = currentDraft?.balanceDueDate ?? null;
  const [balanceDueDate, setBalanceDueDate] = useState(draftDueDate ?? suggestedBalanceDueDate ?? "");
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);
  const [missing, setMissing] = useState<MissingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phoneSaved, setPhoneSaved] = useState(false);
  const [pending, start] = useTransition();
  // Direct contracts: what the draft was generated with, so regenerating never silently changes it.
  const [total, setTotal] = useState(currentDraft?.totalCents != null ? centsToInputValue(currentDraft.totalCents) : "");
  const [deposit, setDeposit] = useState(currentDraft?.depositCents != null ? centsToInputValue(currentDraft.depositCents) : "");
  const [depositEdited, setDepositEdited] = useState(currentDraft?.depositCents != null);
  const [services, setServices] = useState(currentDraft?.services ?? "");
  const [overrideDeposit, setOverrideDeposit] = useState(false);
  const version = versions.find((v) => v.id === versionId);
  const totalCents = parseMoneyToCents(total);
  // Only fields the template actually uses are asked for: its text is what the client signs.
  const asksForMoney = Boolean(direct && version?.usesPayment);
  const sentTotal = asksForMoney ? total : "";
  const sentDeposit = asksForMoney && version?.statesDeposit ? deposit : "";
  const requiredDeposit = direct && totalCents !== null ? Math.floor((totalCents * direct.depositPercent + 50) / 100) : null;
  const belowRequirement = Boolean(
    direct?.depositRequired && !(asksForMoney && totalCents !== null && totalCents > 0 && requiredDeposit !== null && (parseMoneyToCents(sentDeposit) ?? 0) >= requiredDeposit),
  );
  // The chosen version prints the client's phone and the signer has none: say so before generating, with the fix here.
  const phoneNeeded = Boolean(signer && !signer.phone && (version?.needsClientPhone || missing.some((m) => m.key === "client.phone")));

  function run(replaceContractId: string | null) {
    setError(null);
    setMissing([]);
    start(async () => {
      // Only sent when the chosen version asks for it; the server rejects it otherwise.
      const dueDate = version?.needsBalanceDueDate ? balanceDueDate : "";
      const result: GenerateResult = direct
        ? await generateDirectContract(slug, direct.eventId, {
            templateVersionId: versionId,
            total: sentTotal,
            deposit: sentDeposit,
            balanceDueDate: asksForMoney ? dueDate : "",
            services: version?.needsServices ? services : "",
            overrideDeposit: belowRequirement && overrideDeposit,
            replaceContractId,
          })
        : await generateContract(slug, approvalId!, { templateVersionId: versionId, balanceDueDate: dueDate, replaceContractId });
      switch (result.status) {
        case "created":
        case "replayed":
          setConfirmReplace(null);
          router.push(`/staff/${slug}/contracts/${result.contractId}`);
          break;
        case "draft_exists":
          setConfirmReplace(result.contractId);
          break;
        case "incomplete":
          setConfirmReplace(null);
          setMissing(result.missing);
          break;
        case "override_required":
          setConfirmReplace(null);
          setError(`Your business requires a deposit of at least ${result.depositPercent}%. Confirm going below it to continue.`);
          break;
        case "error":
          setConfirmReplace(null);
          setError(result.message);
          break;
      }
    });
  }

  const legacyNote =
    legacyHidden > 0 ? (
      <p className="text-sm text-muted-foreground">
        {legacyHidden} version(s) published before agreements could be approved for client use aren&apos;t listed. To use one, open its
        template, start a new draft version and publish it for client use.{" "}
        <Link className="underline" href={`/staff/${slug}/contract-templates`}>Contract templates</Link>
      </p>
    ) : null;

  if (versions.length === 0) {
    return (
      <div className="grid gap-2 text-sm">
        <p>
          Publish a contract template version for client use (or as DEMO for testing) first.{" "}
          <Link className="underline" href={`/staff/${slug}/contract-templates`}>Contract templates</Link>
        </p>
        {legacyNote}
        {currentDraft && !currentDraft.signable ? (
          <p>
            The current draft, <Link className="underline" href={`/staff/${slug}/contracts/${currentDraft.id}`}>{currentDraft.label}</Link>, can&apos;t be
            signed online. Regenerate it once a version is published.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-sm">
      {currentDraft ? (
        <p>
          Current draft: <Link className="underline" href={`/staff/${slug}/contracts/${currentDraft.id}`}>{currentDraft.label}</Link>
          {changes.length > 0 ? (
            <span className="block text-amber-800 dark:text-amber-300" data-testid="contract-changes">
              Changed since this draft was generated: {changes.join(", ")}. Regenerate it to use the current details.
            </span>
          ) : null}
          {!currentDraft.signable ? (
            <span className="block text-amber-700 dark:text-amber-400">
              It was generated from a version published before agreements could be approved for client use, so it can&apos;t be sent or
              signed. Regenerate it from a version published for client use.
            </span>
          ) : null}
        </p>
      ) : null}
      {legacyNote}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Template version" htmlFor="template_version_id">
          <select id="template_version_id" className={selectClass} value={versionId} onChange={(e) => setVersionId(e.target.value)} disabled={pending}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </Field>
        {direct && !(asksForMoney && version?.needsBalanceDueDate) ? null : <Field
          label="Remaining balance due"
          htmlFor="balance_due_date"
          hint={
            !version?.needsBalanceDueDate
              ? "This template doesn't use a balance due date."
              : draftDueDate
                ? "The current draft's date. You can change it before regenerating."
                : suggestedBalanceDueDate
                  ? "Defaults to the event date. You can change it before generating the contract."
                  : "Required by this template: the date the remaining balance is due."
          }
        >
          <Input
            id="balance_due_date"
            type="date"
            // A template without the date shows none (nothing is sent for it).
            value={version?.needsBalanceDueDate ? balanceDueDate : ""}
            onChange={(e) => setBalanceDueDate(e.target.value)}
            disabled={pending || !version?.needsBalanceDueDate}
          />
        </Field>}
      </div>

      {direct && version?.needsProposal ? (
        <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3" data-testid="direct-needs-proposal">
          This template uses package or itemized pricing fields, which come from an approved proposal. Choose a template without them.
        </p>
      ) : null}

      {direct && version?.needsServices ? (
        <Field label="Services" htmlFor="contract_services" hint="Printed in the agreement where the template has its Services field.">
          <Textarea id="contract_services" value={services} maxLength={5000} rows={3} onChange={(e) => setServices(e.target.value)} disabled={pending} />
        </Field>
      ) : null}

      {direct && !version?.needsProposal ? (
        asksForMoney ? (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="direct-money">
            <Field label={`Total (${direct.currency})`} htmlFor="contract_total" hint="This template states payment terms. Enter 0 only for a contract that truly costs nothing.">
              <Input
                id="contract_total"
                inputMode="decimal"
                value={total}
                disabled={pending}
                onChange={(e) => {
                  setTotal(e.target.value);
                  // Suggests the business's required deposit until staff type their own.
                  const cents = parseMoneyToCents(e.target.value);
                  if (!depositEdited && direct.depositRequired) setDeposit(cents === null ? "" : centsToInputValue(Math.floor((cents * direct.depositPercent + 50) / 100)));
                }}
              />
            </Field>
            {version?.statesDeposit ? (
              <Field
                label={`Required deposit (${direct.currency})`}
                htmlFor="contract_deposit"
                hint={direct.depositRequired ? `Your business requires ${direct.depositPercent}% before a booking is confirmed.` : "Blank for no deposit. With a deposit, the event is booked once it's received."}
              >
                <Input
                  id="contract_deposit"
                  inputMode="decimal"
                  value={deposit}
                  disabled={pending}
                  onChange={(e) => {
                    setDeposit(e.target.value);
                    setDepositEdited(true);
                  }}
                />
              </Field>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground" data-testid="direct-no-terms">This template has no payment fields, so the contract records no payment terms. The event is booked when the client signs.</p>
        )
      ) : null}

      {direct && !version?.needsProposal && belowRequirement ? (
        direct.isOwner ? (
          <label className="flex items-start gap-2 rounded-lg border p-3" data-testid="deposit-override">
            <input type="checkbox" checked={overrideDeposit} onChange={(e) => setOverrideDeposit(e.target.checked)} disabled={pending} className="mt-0.5 size-4 accent-primary" />
            <span>
              Go without the {direct.depositPercent}% deposit your business requires{requiredDeposit !== null && requiredDeposit > 0 ? ` (${formatCents(requiredDeposit, direct.currency)})` : ""}. As the owner, you can make this exception for this contract.
            </span>
          </label>
        ) : (
          <p role="status" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3" data-testid="deposit-owner-only">
            Your business requires a deposit of at least {direct.depositPercent}% of the total{requiredDeposit !== null && requiredDeposit > 0 ? ` (${formatCents(requiredDeposit, direct.currency)})` : ""}. Only the owner can go below it, so choose a template that states the deposit, or ask the owner.
          </p>
        )
      ) : null}

      {phoneNeeded && signer ? (
        <div className="grid gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3" data-testid="contract-phone-needed">
          <p>
            <span className="font-medium">This template includes the client&apos;s phone.</span> {signer.name}, the signer, has no phone number yet.
            Add it here; the draft is generated with it.
          </p>
          <ActionForm
            action={addClientPhone.bind(null, slug, signer.clientId)}
            submitLabel="Save phone number"
            onSuccess={() => {
              setMissing((m) => m.filter((x) => x.key !== "client.phone"));
              setPhoneSaved(true);
              router.refresh();
            }}
          >
            <TextField label={`Phone number for ${signer.name}`} name="client_phone" type="tel" inputMode="tel" autoComplete="off" required maxLength={PHONE_MAX} placeholder="514 555-0100" hint={PHONE_HINT} />
          </ActionForm>
        </div>
      ) : phoneSaved ? (
        <p role="status" className="text-emerald-700 dark:text-emerald-400">Phone number saved. You can generate the draft now.</p>
      ) : null}

      {confirmReplace ? (
        <div role="dialog" aria-label="Confirm replacing the draft" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Replace the current contract draft?</p>
          <p className="text-muted-foreground">
            A new draft is generated from the chosen version and today&apos;s client, event and business details. The current draft is
            kept as history, marked replaced, and can no longer be used. Nothing is sent to the client.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(confirmReplace)} disabled={pending}>{pending ? "Generating…" : "Replace draft"}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirmReplace(null)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            disabled={pending || !versionId || Boolean(direct && (version?.needsProposal || (belowRequirement && (!direct.isOwner || !overrideDeposit))))}
            onClick={() => (currentDraft ? setConfirmReplace(currentDraft.id) : run(null))}
          >
            {pending ? "Generating…" : currentDraft ? "Regenerate draft…" : "Generate contract draft"}
          </Button>
        </div>
      )}

      {missing.length > 0 ? (
        <div role="alert" className="grid gap-1 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
          <p className="font-medium">Complete this information first. Nothing was generated.</p>
          <ul className="list-disc pl-5">
            {missing.map((m) => <li key={m.key}>{m.key === "client.phone" && signer && !signer.phone ? "Client phone: add it above." : m.hint}</li>)}
          </ul>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  );
}
