# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Responsive web app, installable as a home-screen app (PWA manifest, safe-area aware). Clients mostly plan on phones; staff mostly work on desktop.

## Users

**DJ businesses (tenants).** Independent DJs and small entertainment companies. Each business has its own clients, staff, branding (logo, brand colour, business and DJ names), catalogue, templates and events. Flux DJ is multi-tenant; no business is the default, and BOUPROD is one tenant among others.

**Staff.** Owners and team members who build proposals, send contracts, record payments, set up planning templates, review client plans and produce run sheets.

**Clients (the planning audience).** The people who booked the DJ and fill in event planning:

- Couples and private-party hosts planning their own event. Today most planned events are weddings.
- Event coordinators planning on behalf of an organisation (corporate, school or venue events).

Clients plan occasionally, over weeks or months, often on a phone and in short sessions, sometimes together with a partner. Most are not event professionals. They are giving information to a DJ they have already hired, so trust is established; what they need is clarity, a sense of progress and confidence that nothing is lost.

## Product Purpose

Flux DJ runs a DJ business from first proposal to the night of the event: proposals with options and discounts, contracts with electronic signatures and PDFs, deposits and payments, booking, client planning, staff review, and web/PDF run sheets.

Client planning turns a booked event into a complete, reviewed plan the DJ can perform from. Success means the client finishes the plan before the deadline without needing a call to decode it, the DJ receives answers that are specific enough to act on (exact songs, versions, links, names, order, timing), and the run sheet is ready without re-typing.

## Positioning

Planning is not a standalone questionnaire. It is the client-facing half of a workflow the DJ already runs in Flux DJ:

- Questions come from the DJ's own templates and follow the real order of the event (stages and moments), not a generic form.
- Answers feed the staff review and the run sheet directly; what the client enters is what the DJ performs from.
- It knows the booking: date, venue, contracted services, proposal answers already given ("Already provided"), planning deadline and read-only state.
- It understands event music (song, artist, version, link, playback instructions, cues, playlists, do-not-play) and event roles (processional, introductions, speeches, MC), with domain checks such as duplicate songs and timing order.
- It is branded as the DJ business the client hired, not as Flux DJ.

## Operating Context

- Clients reach planning from an invitation email or their events list (`/my`), signed in with a verified email link.
- Planning opens once the event is booked and staff have set it up; until then clients see a "setting up" notice.
- A planning deadline (or a DJ closing planning) makes it read-only; staff can reopen it.
- Every answer autosaves per item with revision checks; pending, failed, conflicting and signed-out saves are surfaced and never silently dropped.
- Planning is organised as general sections (Event basics, Contacts and vendors, DJ expectations and overall preferences) followed by the event's stages in order (for a wedding: Ceremony, Cocktail, Reception entrance, Dinner, Special dances, Party, Closing), each with moments.
- Starter templates exist for Wedding and Simple Party; businesses customise and add their own.
- Staff see and edit the same plan on their side and generate run sheets from it.

## Capabilities and Constraints

- Multi-tenant with row-level security and tenant isolation; archived events and businesses are read-only.
- Client-visible data is limited to client-safe fields.
- Answer schemas, planning questions, autosave behaviour and business rules are stable; presentation work must not change them.
- Recent planning work that must be preserved: DJ microphone interaction levels, MC responsibilities including shared MC, configurable business and event DJ names, legacy answers kept readable (Batch 6A); consistent song entry (title, artist, version, link, playback instructions), collapsible optional music fields, song links in run sheets, disclosures reset when leaving a section, protected pending and failed saves (Batch 6B).
- Terminology in use: "section", "stage" ("part of your event"), "moment", "Discuss with your DJ", "Not applicable", "DJ's choice", "Already provided".
- Undecided: whether client pages should support dark mode (they are light-only today).

## Brand Commitments

- Two brand layers. The DJ business's identity (logo, display name, brand colour) leads on client pages. Flux DJ's own identity (wordmark, black-and-white "F" app icon) belongs to platform and staff surfaces.
- Client planning uses a neutral Flux-designed interface with the business's brand colour as its only accent. Any brand colour a business picks, from near-black to pale lavender, must stay legible and accessible.
- Planning must feel welcoming for any event type. It must not become wedding-themed, even though weddings are the most common event today.
- Chosen direction for client planning: "Premium and Welcoming": modern, refined, professional, friendly, calm, intuitive, purposeful and distinctive. The bar is the polish and restraint of products such as Linear, Airbnb and Notion, without copying them.
- Voice: plain, warm, second person, specific about consequences ("Progress shows what you've filled in; it doesn't mean your DJ has approved it"). Never alarming about unanswered questions.

## Evidence on Hand

- Flux brand assets: `assets/brand/flux-app-icon.png`, `assets/brand/flux-wordmark-black.png`, `assets/brand/flux-wordmark-white.png` (also in `public/brand/`).
- Tenant brand colour and logo per business (`tenants.brand_colors`, logo storage).
- No testimonials, customer quotes, usage metrics or case studies exist in the repository. Future work must not invent them.

## Product Principles

1. **A workspace, not a survey.** The client should be able to see their event taking shape: what is decided, what is left, and what the DJ will do with it. Answers stay visible after they are given.
2. **The business's name is on the door.** Client pages represent the DJ business that was hired. Flux DJ supports that identity; it never competes with it.
3. **Never lose a client's work, and never make them anxious about it.** Saving is trustworthy and quiet when it works, clear and actionable when it doesn't.
4. **Specific beats generic.** The product earns its place by understanding event music, roles and timing better than a form builder could. Presentation should make that domain knowledge visible.
5. **Every event type is first-class.** Copy, structure and visuals work for a corporate gala or a school dance as well as for a wedding.

## Accessibility & Inclusion

- WCAG 2.2 AA is the working standard: contrast, keyboard access, visible focus, labelled controls, announced status changes.
- Phone-first: 44px touch targets, no horizontal scrolling at 390px, zoom never disabled, safe areas respected.
- Reduced-motion preferences are honoured; navigation scrolls instantly rather than smoothly.
- Any tenant brand colour must keep text and controls legible (contrast-safe foregrounds are already computed in `src/lib/branding/colors.ts`).
