import "server-only";
import { IntegrityError, readVerifiedDocument, type DocumentRef } from "./documents.server";
import { signedPdfFileName } from "./pdf/data";
import { createAdminClient } from "@/lib/supabase/admin";

const PRIVATE = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" };

/** A plain-text error that is never cached. */
export function privateError(status: number, message: string): Response {
  return new Response(message, { status, headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * Streams an authorized, committed PDF after checking its bytes against the
 * recorded SHA-256. The caller has already authorized the request; this
 * never issues a URL that outlives it.
 */
export async function verifiedPdfResponse(doc: DocumentRef, eventTitle: string, eventDate: string): Promise<Response> {
  let bytes: Buffer;
  try {
    bytes = await readVerifiedDocument(createAdminClient(), doc);
  } catch (cause) {
    if (cause instanceof IntegrityError) return privateError(500, "The signed PDF failed its integrity check and was not delivered. Contact your DJ.");
    return privateError(503, "The signed PDF could not be read right now. Try again in a moment.");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PRIVATE,
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${signedPdfFileName(eventTitle, eventDate)}"`,
      "X-Content-SHA256": doc.pdf_sha256,
    },
  });
}
