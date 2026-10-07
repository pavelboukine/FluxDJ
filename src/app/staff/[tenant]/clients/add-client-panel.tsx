"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider, useDraftEditorState } from "@/components/app/draft-version";
import type { ActionState } from "@/lib/forms";
import { ClientFields } from "./client-fields";

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  /** Shown at once (a business with no clients yet). */
  initiallyOpen: boolean;
};

/**
 * The add-client form, revealed by the page's "Add client" button or the
 * dashboard's #add-client link, with its first field focused. Cancel never
 * drops typed details silently: with unsaved values it asks first. Values
 * typed during a pending or failed save stay (ActionForm keeps them).
 */
export function AddClientPanel(props: Props) {
  return (
    <DraftVersionProvider version={0}>
      <Panel {...props} />
    </DraftVersionProvider>
  );
}

function Panel({ action, initiallyOpen }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  const section = useRef<HTMLElement>(null);
  const form = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reveal = () => {
      setOpen(true);
      // After it is shown: bring it into view and focus the first field.
      window.requestAnimationFrame(() => {
        section.current?.scrollIntoView({ block: "start" });
        section.current?.querySelector<HTMLInputElement>("input")?.focus();
      });
    };
    if (window.location.hash === "#add-client") reveal();
    const onHash = () => {
      if (window.location.hash === "#add-client") reveal();
    };
    // The button links here; a click opens it even when the address already ends in #add-client.
    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href="#add-client"]');
      if (link) {
        e.preventDefault();
        if (window.location.hash !== "#add-client") window.history.replaceState(null, "", "#add-client");
        reveal();
      }
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick);
    };
  }, []);

  function close() {
    if (unsaved) {
      if (!window.confirm("Discard the client details you typed?")) return;
      const el = form.current?.querySelector("form");
      el?.reset();
      // Lets the form recompute its unsaved state after the reset.
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setOpen(false);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    document.querySelector<HTMLElement>('a[href="#add-client"]')?.focus();
  }

  return (
    <section ref={section} id="add-client" hidden={!open} aria-labelledby="add-client-heading" className="scroll-mt-20 grid gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="add-client-heading" className="text-base font-semibold">Add a client</h2>
        <Button type="button" variant="ghost" size="sm" onClick={close}>Cancel</Button>
      </div>
      <div ref={form}>
        <ActionForm action={action} submitLabel="Add client" resetOnSuccess trackUnsaved>
          <ClientFields />
        </ActionForm>
      </div>
    </section>
  );
}
