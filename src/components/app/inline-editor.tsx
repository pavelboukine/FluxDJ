"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/app/action-form";
import { DraftVersionProvider, useDraftEditorState } from "@/components/app/draft-version";
import type { ActionState } from "@/lib/forms";

type Props = {
  /** The section's id: a link to #id opens the editor. */
  id: string;
  title: string;
  editLabel: string;
  /** Read-only overview, shown while not editing. */
  view: ReactNode;
  /** The form fields (named as the action expects). */
  children: ReactNode;
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  submitLabel: string;
  /** Asked before Cancel discards typed changes. */
  discardMessage: string;
};

/**
 * A record's overview with an explicit Edit action that swaps in the form.
 *  - The form stays mounted (hidden) so it never loses state on its own;
 *    errors and pending saves keep typed values (ActionForm).
 *  - Cancel with unsaved changes asks first; leaving the page asks too.
 *  - A successful save returns to the overview, refreshed, with its message.
 *  - Focus moves to the first field on Edit and back to Edit afterwards.
 */
export function InlineEditor(props: Props) {
  return (
    <DraftVersionProvider version={0}>
      <Editor {...props} />
    </DraftVersionProvider>
  );
}

function Editor({ id, title, editLabel, view, children, action, submitLabel, discardMessage }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // A fresh form (current values, no old message) each time editing starts.
  const [round, setRound] = useState(0);
  const unsaved = useDraftEditorState()?.unsaved ?? false;
  const formBox = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);

  function open() {
    setSaved(null);
    setRound((n) => n + 1);
    setEditing(true);
    window.requestAnimationFrame(() => formBox.current?.querySelector<HTMLElement>("input:not([disabled]), textarea, select")?.focus());
  }

  function close() {
    setEditing(false);
    window.requestAnimationFrame(() => editButton.current?.focus());
  }

  // A link to #id (e.g. from another page) opens the editor once the page has loaded.
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    const frame = window.requestAnimationFrame(open);
    return () => window.cancelAnimationFrame(frame);
  }, [id]);

  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  function cancel() {
    if (unsaved) {
      if (!window.confirm(discardMessage)) return;
      const form = formBox.current?.querySelector("form");
      form?.reset();
      // Lets the form recompute its unsaved state after the reset.
      form?.dispatchEvent(new Event("input", { bubbles: true }));
    }
    close();
  }

  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-20 grid min-w-0 gap-4 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-base font-semibold">{editing ? editLabel : title}</h2>
        {editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        ) : (
          <Button ref={editButton} type="button" variant="outline" size="sm" onClick={open}>
            <Pencil aria-hidden />
            {editLabel}
          </Button>
        )}
      </div>
      {editing ? null : (
        <>
          {view}
          {saved ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{saved}</p> : null}
        </>
      )}
      <div ref={formBox} hidden={!editing}>
        <ActionForm
          key={round}
          action={action}
          submitLabel={submitLabel}
          trackUnsaved
          onSuccess={(result) => {
            setSaved(result.status === "success" ? result.message : null);
            close();
            router.refresh();
          }}
        >
          {children}
        </ActionForm>
      </div>
    </section>
  );
}
