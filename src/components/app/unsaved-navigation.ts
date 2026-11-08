/**
 * Asking before unsaved edits are lost. A page opts in by wrapping its forms in
 * an element with `data-unsaved-guard`; ActionForm marks a form with
 * `data-unsaved` while it has edits (trackUnsaved), so any number of forms on
 * the page count. Other pages are unaffected. Links go through PendingLink's
 * onNavigate; closing or reloading the tab goes through beforeunload.
 *
 * Browser Back isn't covered: Next.js offers no supported way to stop it.
 */
const UNSAVED_FORMS = "[data-unsaved-guard] form[data-unsaved]";
export const UNSAVED_MESSAGE = "You have unsaved changes. Leave this page without saving them?";

/** Set once someone chooses to leave, so a navigation that reloads the page doesn't ask a second time. */
let leaving = false;

export function hasUnsavedChanges(): boolean {
  return !leaving && document.querySelector(UNSAVED_FORMS) !== null;
}

/** Whether a link may go ahead. An in-page link to the same path loses nothing, so it never asks. */
export function confirmLeavingUnsaved(href: string | undefined): boolean {
  if (!hasUnsavedChanges()) return true;
  if (href !== undefined && new URL(href, window.location.href).pathname === window.location.pathname) return true;
  if (!window.confirm(UNSAVED_MESSAGE)) return false;
  leaving = true;
  // A client-side navigation stays in this document: the next page starts fresh.
  window.setTimeout(() => { leaving = false; }, 1000);
  return true;
}
