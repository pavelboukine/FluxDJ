"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/app/action-form";
import { idleState, type ActionState } from "@/lib/forms";
import { setPackageArchived } from "../actions";

/** Archive (after a confirmation that says what changes) or restore a package. Nothing is deleted. */
export function PackageArchivePanel({ slug, packageId, name, archived, templates }: { slug: string; packageId: string; name: string; archived: boolean; templates: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<ActionState>(idleState);
  const [pending, start] = useTransition();

  function run(next: boolean) {
    start(async () => {
      const result = await setPackageArchived(slug, packageId, next);
      setState(result);
      setConfirming(false);
      if (result.status === "success") router.refresh();
    });
  }

  return (
    <div className="grid gap-3 text-sm">
      {archived ? (
        <div>
          <Button type="button" variant="outline" onClick={() => run(false)} disabled={pending}>{pending ? "Restoring…" : "Restore package"}</Button>
        </div>
      ) : confirming ? (
        <div role="dialog" aria-label="Confirm archiving the package" className="grid gap-2 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Archive {name}?</p>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>It&apos;s hidden from the packages list (unless you include archived) and can&apos;t be chosen for templates or proposal drafts.</li>
            {templates > 0 ? (
              <li className="text-foreground">
                {templates === 1 ? "1 proposal template still offers it" : `${templates} proposal templates still offer it`} (see Used in). Proposals that offer
                it, from those templates or drafts, can&apos;t be previewed or sent until you choose another package or restore it.
              </li>
            ) : null}
            <li>Its included gear is kept. Proposals already sent keep their own copy of the package.</li>
          </ul>
          <p className="text-muted-foreground">Nothing is deleted. You can restore it at any time.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => run(true)} disabled={pending}>{pending ? "Archiving…" : "Archive package"}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>Archive…</Button>
        </div>
      )}
      <FormMessage state={state} />
    </div>
  );
}
