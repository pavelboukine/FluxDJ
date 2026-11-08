/**
 * Logo size: how far a surface's height limit rises (tenants.logo_size_percent, in
 * the database's range). A square logo has far less area than a wide wordmark at the
 * same height, so raising the limit is what helps it, and a wide logo stops at its
 * surface's width limit instead. BrandLogo sets --logo-scale; a surface opts in by
 * using one of these height limits, so the image stays in the layout (no transform)
 * and at 100% each limit is exactly the surface's original one. Never enlarged past
 * the file's own pixels.
 *
 * The staff header is a fixed 56px, and a light logo's dark plate adds 8px, so its
 * largest logo is 47px. Client pages' headers can grow, so theirs carry a cap.
 *
 * Proposals (frozen when sent), emails (frozen per message, fixed box) and the
 * client's list of events (several businesses side by side) don't use it.
 */
export const LOGO_SIZE = { min: 100, max: 130, step: 5, default: 100 } as const;

export const STAFF_HEADER_LOGO_HEIGHT = "max-h-[calc(2rem*var(--logo-scale,1))] lg:max-h-[calc(2.25rem*var(--logo-scale,1))]";
/** The logo above a client event, proposal or planning page. */
export const CLIENT_PAGE_LOGO = "max-h-[calc(2.25rem*var(--logo-scale,1))] max-w-36";
export const CLIENT_CONTRACT_LOGO = "max-h-[min(calc(2.5rem*var(--logo-scale,1)),3rem)] max-w-40";
/** The business's own invitation pages, where the logo is already the largest. */
export const PUBLIC_CARD_LOGO = "max-h-[min(calc(3.5rem*var(--logo-scale,1)),4rem)] max-w-48 sm:max-h-[min(calc(4rem*var(--logo-scale,1)),4.5rem)] sm:max-w-56";

export const logoSizeLabel = (percent: number) => (percent === LOGO_SIZE.default ? "Default" : `${percent}%`);
