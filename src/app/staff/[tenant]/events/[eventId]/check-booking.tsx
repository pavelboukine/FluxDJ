"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { checkBooking } from "../payment-actions";

/** Explicit booking check for a contract signed before booking policies existed. */
export function CheckBooking({ slug, eventId }: { slug: string; eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await checkBooking(slug, eventId);
            setState(result);
            router.refresh();
          })
        }
      >
        {pending ? "Checking…" : "Check booking"}
      </Button>
      <FormMessage state={state} />
    </div>
  );
}
