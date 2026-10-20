/**
 * How planning refers to the DJ. The business's display name (the company
 * brand) is never used as the DJ's name: several DJs may work for one
 * business. General wording says "your DJ" to clients and "the DJ" to staff;
 * only questions about who does what name the DJ handling the event, when
 * one is configured (events.dj_name, else tenants.dj_name).
 */
export type Audience = "client" | "staff";

/** "your DJ" (clients) or "the DJ" (staff), for general wording. */
export const djRef = (audience: Audience) => (audience === "client" ? "your DJ" : "the DJ");

/** A generic "discuss" option: "Not sure yet — discuss with your DJ". */
export const discussLabel = (audience: Audience) => `Not sure yet — discuss with ${djRef(audience)}`;

/** Replaces "the DJ" in shared option wording with the audience's reference. */
export const withDj = <T extends readonly (readonly [string, string])[]>(options: T, audience: Audience) =>
  options.map(([value, label]) => ({ value, label: label.replace("the DJ", djRef(audience)) }));

/** The event's DJ name: its own, else the business's, else null (blank names count as none). */
export function resolveDjName(eventDjName: string | null | undefined, businessDjName: string | null | undefined): string | null {
  return eventDjName?.trim() || businessDjName?.trim() || null;
}

/** The DJ named where planning asks who does what: "DJ Boukine (your DJ)", or "Your DJ" / "The DJ" without a name. */
export function djIdentity(name: string | null | undefined, audience: Audience): string {
  const ref = djRef(audience);
  return name?.trim() ? `${name.trim()} (${ref})` : ref.charAt(0).toUpperCase() + ref.slice(1);
}
