import Link from "next/link";
import { needsTaxSetup } from "@/lib/db-errors";

/** A link to the tax settings, shown only when an offer error is a tax configuration problem. */
export function TaxSetupLink({ slug, message }: { slug: string; message: string | null | undefined }) {
  if (!message || !needsTaxSetup(message)) return null;
  return (
    <Link className="font-medium underline" href={`/staff/${slug}/settings#taxes`}>
      Open tax settings
    </Link>
  );
}
