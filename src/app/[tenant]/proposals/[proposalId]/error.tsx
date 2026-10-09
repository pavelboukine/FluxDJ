"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A proposal that can't be shown or priced (for example an offer that fails
 * its integrity checks). The client sees a plain message and a retry, never
 * the underlying error.
 */
export default function ProposalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="mx-auto grid w-full max-w-md flex-1 content-center px-4 py-16">
      <div role="alert" className="grid gap-3 rounded-2xl border p-6 text-sm shadow-sm">
        <AlertTriangle aria-hidden className="size-8 text-muted-foreground" />
        <h1 className="text-xl font-semibold">This proposal can&apos;t be shown right now</h1>
        <p>Something went wrong while preparing it. Your saved choices are not affected. Please try again, or contact your DJ if this keeps happening.</p>
        <Button type="button" variant="outline" className="min-h-11 justify-self-start" onClick={() => retry()}>
          Try again
        </Button>
      </div>
    </main>
  );
}
