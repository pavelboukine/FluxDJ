/**
 * Which of a section's ids the page's address points at, and the listeners
 * that report it (used by Disclosure). Kept free of React and of the real
 * DOM types so it can be tested on its own.
 *
 * The address reaches an id in three ways:
 *  - on load, or a hash change (an in-page link, or typing the address);
 *  - browser back/forward between entries of the same page (popstate, and
 *    hashchange when only the fragment differs: both are handled, and
 *    reporting twice is harmless);
 *  - a click on a link to it, even when the address already points there
 *    (no hashchange) or a client-side router sets the hash without firing one.
 */

type Listenable = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
};
export type HashWindow = Listenable & { location: { hash: string; href: string; pathname: string }; document: Listenable };
type LinkLike = { href: string; pathname: string };

export type HashSource = "address" | "click";

/** The id among `ids` that `hash` ("#payments") points at, or null. */
export function targetedId(hash: string, ids: readonly string[]): string | null {
  if (!hash.startsWith("#") || hash.length < 2) return null;
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape: compare it as written.
  }
  return ids.includes(id) ? id : null;
}

/** Calls `onMatch` whenever the address points at one of `ids` (see above). Returns the cleanup. */
export function watchHashTargets(win: HashWindow, ids: readonly string[], onMatch: (id: string, source: HashSource) => void): () => void {
  const sync = () => {
    const id = targetedId(win.location.hash, ids);
    if (id) onMatch(id, "address");
  };
  const onClick = (e: Event) => {
    const target = e.target as { closest?: (selector: string) => unknown } | null;
    const link = target?.closest?.("a[href]") as LinkLike | null | undefined;
    if (!link || link.pathname !== win.location.pathname) return;
    const id = targetedId(new URL(link.href, win.location.href).hash, ids);
    if (id) onMatch(id, "click");
  };
  sync();
  win.addEventListener("hashchange", sync);
  win.addEventListener("popstate", sync);
  win.document.addEventListener("click", onClick);
  return () => {
    win.removeEventListener("hashchange", sync);
    win.removeEventListener("popstate", sync);
    win.document.removeEventListener("click", onClick);
  };
}
