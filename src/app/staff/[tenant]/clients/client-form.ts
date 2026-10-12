import { z } from "zod";
import { optionalText, text } from "@/lib/forms";
import { checkClientPhone } from "@/lib/phone";

/**
 * Parses the shared client fields (client_name, client_email, client_phone).
 * `currentPhone` is the stored number when editing: an unchanged number is
 * kept as it is, so a record saved before phone checks existed can still
 * have its name or email corrected.
 */
export function readClientForm(form: FormData, currentPhone?: string | null) {
  const name = text(form, "client_name");
  const email = text(form, "client_email").toLowerCase();
  const rawPhone = optionalText(form, "client_phone");
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Client name is required." } as const;
  if (!z.email().max(320).safeParse(email).success) return { ok: false, error: "Enter a valid client email." } as const;
  let phone: string | null = rawPhone;
  if (!(currentPhone && rawPhone === currentPhone.trim())) {
    const checked = checkClientPhone(rawPhone);
    if (!checked.ok) return { ok: false, error: checked.message } as const;
    phone = checked.value;
  }
  return { ok: true, values: { name, email, phone } } as const;
}
