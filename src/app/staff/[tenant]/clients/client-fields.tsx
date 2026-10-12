import { TextField } from "@/components/app/fields";
import { PHONE_HINT, PHONE_MAX } from "@/lib/phone";

type Client = { name: string; email: string; phone: string | null; updated_at?: string };

/**
 * The client contact fields. `contractsNeedPhone` (the business's contract
 * template prints the client's phone) makes the phone hint say when it will
 * be needed, so nobody discovers it at the contract step. Editing carries
 * the record's version (updated_at) so a stale form can't overwrite newer
 * details.
 */
export function ClientFields({ client, optional, contractsNeedPhone }: { client?: Client; optional?: boolean; contractsNeedPhone?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {client?.updated_at ? <input type="hidden" name="client_updated_at" value={client.updated_at} /> : null}
      <TextField label="Name" name="client_name" required={!optional} maxLength={200} autoComplete="off" defaultValue={client?.name} placeholder="Alex & Sam" />
      <TextField label="Email" name="client_email" type="email" required={!optional} maxLength={320} autoComplete="off" defaultValue={client?.email} placeholder="alex@example.com" />
      <TextField
        label="Phone (optional)"
        name="client_phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={PHONE_MAX}
        defaultValue={client?.phone ?? ""}
        placeholder="514 555-0100"
        hint={contractsNeedPhone ? `Optional for now. Your contract template includes the client's phone, so it's needed before you generate a contract. ${PHONE_HINT}` : PHONE_HINT}
      />
    </div>
  );
}
