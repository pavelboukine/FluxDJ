import { z } from "zod";
import { optionalText, text } from "@/lib/forms";

/** Parses the shared client fields (client_name, client_email, client_phone). */
export function readClientForm(form: FormData) {
  const name = text(form, "client_name");
  const email = text(form, "client_email").toLowerCase();
  const phone = optionalText(form, "client_phone");
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Client name is required." } as const;
  if (!z.email().max(320).safeParse(email).success) return { ok: false, error: "Enter a valid client email." } as const;
  if (phone && phone.length > 40) return { ok: false, error: "Phone number is too long." } as const;
  return { ok: true, values: { name, email, phone } } as const;
}
