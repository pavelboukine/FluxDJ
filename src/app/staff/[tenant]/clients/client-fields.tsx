import { TextField } from "@/components/app/fields";

export function ClientFields({ client, optional }: { client?: { name: string; email: string; phone: string | null }; optional?: boolean }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <TextField label="Name" name="client_name" required={!optional} maxLength={200} defaultValue={client?.name} placeholder="Alex & Sam" />
      <TextField label="Email" name="client_email" type="email" required={!optional} maxLength={320} defaultValue={client?.email} placeholder="alex@example.com" />
      <TextField label="Phone (optional)" name="client_phone" type="tel" maxLength={40} defaultValue={client?.phone ?? ""} />
    </div>
  );
}
