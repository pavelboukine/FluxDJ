import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RunSheetView } from "@/components/run-sheet/run-sheet-view";
import { requireStaff } from "@/lib/auth/staff";
import { UUID_RE } from "@/lib/forms";
import { loadRunSheet } from "@/lib/run-sheet/load.server";

export const metadata: Metadata = { title: "Run sheet", robots: { index: false, follow: false } };

/**
 * The live run sheet: staff of the event's business only (checked on every
 * request through the staff session), rendered from the latest saved plan.
 * A reload always reads the database again, so staff edits made after the
 * client deadline appear immediately.
 */
export default async function RunSheetPage({ params }: PageProps<"/staff/[tenant]/events/[eventId]/run-sheet">) {
  const { tenant: slug, eventId } = await params;
  if (!UUID_RE.test(eventId)) notFound();
  const { supabase, tenant } = await requireStaff(slug);
  const loaded = await loadRunSheet(supabase, tenant, eventId);
  if (!loaded) notFound();
  const base = `/staff/${slug}/events/${eventId}`;
  return (
    <RunSheetView
      sheet={loaded.sheet}
      revision={loaded.revision}
      pdfHref={`${base}/run-sheet/pdf`}
      planningHref={`${base}/planning`}
      refreshHref={`${base}/run-sheet`}
    />
  );
}
