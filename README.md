# Flux DJ

Branded proposal, contract and event planning portal for independent DJs.
The source of truth for scope and behavior is [docs/Flux-DJ-V1-Spec.md](docs/Flux-DJ-V1-Spec.md).

**Current status: Phase 1 complete (steps 1 to 6) and Phase 2 step 1 (contract
templates and contract drafts).** The stack is scaffolded and the data
foundation is in place:

- Tenancy: tenants, memberships, clients, events, event contacts and event access.
- Catalog: gear items with private image/video media, packages with included
  gear, logistics questions with constrained rules, and reusable proposal
  templates.
- Offers and pricing: a shared deterministic pricing module, one editable
  proposal draft per event, previews, and offer snapshots that freeze once.
- Staff interface: magic-link login, and screens for gear (with photos and
  videos), packages, questions and rules, templates, clients and events. It
  also has a proposal builder with a responsive live preview.
- Proposals end to end: staff send an offer, the client opens a private link
  with no account, edits with autosave, and submits for review. Staff then
  approve the exact submission or send a revised offer. A durable email
  outbox delivers locally through Mailpit.

- Contracts, step 1: versioned contract templates with immutable published
  versions, and contract drafts generated from an approved selection and
  previewed by staff. Drafts are frozen when generated. They are never sent.

- Contracts, later steps: sending with verified client access, resend and
  void, signing by the frozen signer with immutable evidence, and signed
  PDFs emailed to both parties. Each template version is published either as
  DEMO (test wording, labelled everywhere) or for client use (the business's
  own agreement, approved by the owner).

- Manual payment tracking: staff record payments received elsewhere, invalidate
  wrong entries with a reason, and add an optional invoice link. Totals come
  from the authoritative contract; the client sees a read-only summary.

- Booking confirmation: each business chooses (owner only) whether a booking
  is confirmed when the contract is signed, or when it is signed and the
  deposit is received (the default). Each contract freezes the policy, and
  Flux DJ confirms the booking automatically, once, with a confirmation email.

- Planning foundation: reusable planning templates (Wedding and Simple Party
  starters, added on request), one plan per event created when it is booked,
  stages and moments in event order, a small Event basics editor, frozen
  proposal answers shown as "Already provided", and progress computed by the
  database over the sections that exist so far.
- Stage details: timing, location and a few preparation details inside the
  ceremony, cocktail, reception entrance, dinner, party and closing stages,
  with explicit next-day times and timing warnings.
- Planning deadline: client edits close a set number of days before the
  event (owner setting, 14 by default), enforced by the database; staff keep
  editing, and can move one event's deadline or reopen client editing
  temporarily, with a reason, all audited.
- DJ run sheet: a staff-only live view for gig night and an on-demand PDF,
  both from one read-only projection of the latest saved plan.
- Invite-only DJ onboarding: a platform administrator invites a DJ business
  owner by email; the DJ verifies that address, names the business and
  chooses its web address, and gets a new, empty workspace. See "DJ
  invitations and new workspaces".
- Workspace suspension: a platform administrator can suspend a workspace
  (blocking all access to it without deleting anything) and restore it. See
  "Suspending and restoring a workspace".
- Business branding: each owner uploads a logo and picks a primary colour in
  Settings; the workspace header and client pages use them. See "Business
  branding".

Everything has row-level security and tests. Not built yet: payment
processing, PWA and offline access, reminders, cancellations and amendments.
Approval and contract drafts are not bookings.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS · shadcn/ui · Supabase
(Postgres, Auth) · Zod. Package versions are pinned in `package.json` and
`pnpm-lock.yaml`.

## Prerequisites

- Node.js 20.9 or newer
- pnpm (the repo pins its version through `packageManager`)
- Docker Desktop, running. The local Supabase stack runs in containers.

The Supabase CLI is a dev dependency, so no global install is needed.

## Local setup

```bash
pnpm install
pnpm db:start          # starts local Supabase, applies migrations and seed.sql
cp .env.example .env.local
pnpm exec supabase status   # copy the local API URL, anon key and service role key into .env.local
pnpm dev               # http://127.0.0.1:3000
```

The first `pnpm db:start` downloads the Supabase Docker images and takes a
few minutes. Local Studio runs at http://127.0.0.1:54323 and captured emails
(magic links) at http://127.0.0.1:54324.

Useful commands:

| Command | What it does |
|---|---|
| `pnpm db:reset` | Recreate the local database from migrations, then apply `supabase/seed.sql` |
| `pnpm db:types` | Regenerate `src/lib/supabase/database.types.ts` after a migration |
| `pnpm db:stop` | Stop the local Supabase containers |
| `pnpm db:versions` | Show the running service versions next to the hosted ones (read only; fails if they differ) |

### Local Supabase versions

Local should run the same service versions as the hosted project (this is
how a PostgREST behaviour difference was caught; see "Version conflicts"
below). When the repo is linked, `supabase link` records the hosted
versions in the git-ignored `supabase/.temp/*-version` files, and
`supabase start` uses them. So:

1. After any `pnpm db:start` (or a stop/start), run `pnpm db:versions`. It
   lists PostgREST, Auth, Storage and Postgres as running locally next to the
   hosted versions, and exits non-zero if they differ.
2. If they differ (for example a stack started before the repo was linked, or
   with an older CLI), restart it: `pnpm db:stop && pnpm db:start`. Data is
   kept in the Docker volumes; `db:reset` is never needed for this.
3. After a hosted Supabase upgrade, refresh the recorded versions explicitly
   with `pnpm exec supabase link --project-ref <ref>`, then restart and check
   again. Nothing changes those files silently: the link command is the only
   writer.
4. To try the CLI's own default versions instead (only to compare
   behaviour), move `rest-version` and `storage-version` out of
   `supabase/.temp`, restart, put them back, and restart again before normal
   work. `pnpm db:versions` shows which state you are in.

### Version conflicts

Saves that carry a version ("Someone else saved changes first") raise
SQLSTATE `PT409` in the database, which PostgREST answers at once with HTTP
409 and code `PT409`; `describeDbError` turns it into the conflict message,
and forms keep what was typed. Never use `serialization_failure` (40001)
for this: PostgREST v14 (the hosted version) retries 40001 as a transient
failure, so a stale save would never answer and the database would roll
back thousands of transactions a second. Migration
`20261017000100_version_conflict_errors.sql` converted every such check; the
pgTAP guard `32_version_conflicts` fails if one comes back. Genuine
serialization failures raised by Postgres itself are not affected.

Everything above touches only the local Docker database. A CLI link to the
hosted project lives only in the git-ignored `supabase/.temp`. Commands with
`--linked`, `db push` above all, act on the hosted database: run
`db push --linked --dry-run` first, and never `db reset` or `--include-seed`
against it. See "Hosted setup" below.

### Seed data

`supabase/seed.sql` creates two isolated tenants for local development:

| Tenant slug | Owner login | Notes |
|---|---|---|
| `bouprod` | owner@bouprod.example | One event with a verified client |
| `other-dj` | owner@otherdj.example | One event for the same couple, with no client access |

Both tenants have tax categories configured: BOUPROD maps `standard` to
GST and QST, and Other DJ maps it to HST.

BOUPROD also gets a **demo catalog**: five gear items, three packages
(Essential, Signature, Premium), four logistics questions with three rules,
and a "Wedding (DEMO)" template. Every record is tagged DEMO. Prices and
wording are placeholders that Pavel has not reviewed. The catalog mirrors
the spec's pricing example, where separate ceremony and cocktail spaces each
require an additional-location speaker. No media files are seeded.

The client `client@couple.example` has verified access to the BOUPROD event
only. Seeded users have no passwords. Login is magic-link only, and the login
screens arrive in Phase 2.

## Trying it in the browser

With `pnpm db:start` done and `.env.local` filled in, follow these steps:

1. Run `pnpm dev` and open http://127.0.0.1:3000/login. Use `127.0.0.1`, not
   `localhost`, so the magic-link cookie matches the configured site URL.
2. Enter `owner@bouprod.example` and click **Email me a sign-in link**.
3. Open Mailpit at http://127.0.0.1:54324, open the newest "Your Flux DJ
   sign-in link" email, and click **Continue to sign in**. Use the same
   browser.
4. Click **Sign in** on the confirmation page. You land on
   http://127.0.0.1:3000/staff/bouprod.

`owner@otherdj.example` signs in to the second tenant. Its workspace is at
`/staff/other-dj`, and each owner gets a 404 for the other's workspace.
Unknown emails get the same on-screen message, but no email and no account.

| Screen | URL (BOUPROD) |
|---|---|
| Dashboard | http://127.0.0.1:3000/staff/bouprod |
| Gear (photos and videos on each item) | http://127.0.0.1:3000/staff/bouprod/gear |
| Packages | http://127.0.0.1:3000/staff/bouprod/packages |
| Questions and rules | http://127.0.0.1:3000/staff/bouprod/questions |
| Templates | http://127.0.0.1:3000/staff/bouprod/templates |
| Contract templates | http://127.0.0.1:3000/staff/bouprod/contract-templates |
| Clients | http://127.0.0.1:3000/staff/bouprod/clients |
| Events, which is where proposals start | http://127.0.0.1:3000/staff/bouprod/events |

The seeded event "Alex & Sam Wedding" can start a proposal from the
"Wedding (DEMO)" template. Each proposal builder links to a full-page
preview at `/staff/bouprod/proposals/{id}/preview`.

### Sending a proposal and testing it as the client

1. As staff, open http://127.0.0.1:3000/staff/bouprod/events, then
   **Alex & Sam Wedding**. Choose **Wedding (DEMO)** and click **Start
   proposal draft**.
2. Adjust the offer and click **Save draft**. Sending is blocked while
   there are unsaved changes. Click **Review and send…**, check the
   recipient (`client@couple.example`), event and expiry, then click **Send
   proposal now**.
3. Open Mailpit at http://127.0.0.1:54324 and find "BOUPROD sent you a
   proposal for Alex & Sam Wedding". Copy the **View your proposal** link.
   It looks like `http://127.0.0.1:3000/bouprod/p#…`.
4. Paste the link into a **signed-out browser**, such as a private window or
   another browser. It opens `/bouprod/proposals/{id}` with no account and
   no token in the URL.
5. Pick a package, answer the questions and adjust extras. Required gear is
   explained and can't go below its minimum. Changes save automatically,
   and reloading keeps them. Click **Submit for BOUPROD to review**. The
   page shows "Submitted for DJ review."
6. Mailpit now has "Proposal link opened" and "Submitted for your review"
   notices for staff. As staff, reload the proposal page, check the
   submission, then click **Approve…** and confirm. The client gets an email
   saying the contract will follow, and their page shows "Approved by
   BOUPROD."
7. To change terms, click **Start a revised offer** on the proposal, edit
   it and send it. The client's old link and page then say a newer
   proposal is available.

### Contract templates and contract drafts

1. Open http://127.0.0.1:3000/staff/bouprod/contract-templates. The **New
   contract template** form is prefilled with DEMO text marked "DEMO, NOT FOR
   CLIENT USE". It is not a reviewed agreement. Click **Create template
   draft**.
2. On the template page, the right-hand column lists every allowed
   placeholder. Type `{{client.nickname}}` into a section and click **Save
   draft** to see it rejected. Remove it and save.
3. Click **Publish…**, choose **DEMO, for testing** (the starter text is
   DEMO wording), then **Publish version 1 as DEMO**. The version is now
   read-only. **Start draft version 2** copies it into a new editable draft.
   To use your own agreement, replace the text with your wording, save,
   click **Publish…**, keep **For client use**, check the responsibility
   statement and click **Publish version N for client use** (owner only).
4. Approve a proposal as described in the previous section. The approved
   proposal page, and the event page, now show a **Contract** card.
5. Choose the template version and click **Generate contract draft**. With
   the seeded event this works once you enter a **Balance due date**, because
   the DEMO text uses one. To see the missing-information message, clear the
   event's venue address or the client's phone first.
6. The draft opens at `/staff/bouprod/contracts/{id}`. Check the totals,
   the 50% deposit and the balance, then narrow the window to phone width.
7. Back on the proposal, **Regenerate draft…** asks for confirmation and
   keeps the old draft as "replaced". Sending a revised offer marks the draft
   "superseded", and the old approval can no longer be used.

Generating a draft sends no email, does not book the event and gives the
client no access. Clients and anonymous users cannot see templates or drafts.

Delivery problems show under **Emails**
(http://127.0.0.1:3000/staff/bouprod/emails), with **Retry** and **Deliver
due emails now** buttons. Emails go out right after each action. To retry
pending mail in the background, run `pnpm outbox:work` alongside
`pnpm dev`.

### Recording payments

1. Open an event. The **Payments** card shows what has been received. Before
   a contract is sent it shows no total or deposit.
2. Enter an amount, the date it was received and, optionally, a reference
   and an internal note, then click **Record payment**. Recording the same
   amount and date again asks you to confirm it is a separate payment.
3. **Invalidate…** a wrong entry with a reason; it stays in the history,
   struck through. Record the correct payment as a new entry.
4. Paste an `https://` invoice link from any tool (Wave or other) and save.
5. Once a contract is sent, the card compares payments with its frozen
   terms. The client sees the same figures, without references, notes or
   history, on their contract page.

### Planning

1. Open **Planning templates** and click **Add starter templates**. You get
   Wedding and Simple Party, once each, however often you click. Rename,
   **Move up** / **Move down**, remove and add items from the library; keys
   (shown in grey) never change. **Duplicate** and **Archive** are at the
   bottom. Optionally make a template the **Default for event type**.
2. Open an event and its **Planning** card. Before booking you can **Set up
   planning** with a chosen template. Otherwise booking sets it up
   automatically: from the event type's default template, or with Event
   basics only, and the page then prompts you to choose a template.
3. On the planning page, **Apply template** replaces the structure without
   losing answers (confirmation required). **Hide** keeps answers and is undone
   with **Restore**; hiding a stage hides its moments. None of this changes
   the proposal, contract, price, gear or booking.
4. As the client (signed in, booked event), open `/my` or the contract page
   and follow **Plan your event**. Event basics, stage details, songs,
   participants, the MC, speeches, contacts, preferences, activities and
   dedications save automatically.
5. Open a stage card (Ceremony, Cocktail, Reception entrance, Dinner, Party,
   Closing) and fill its details: "Same as the event venue", times with
   **Next day** for after midnight, "Not sure, discuss with DJ". Overlapping
   stages show a timing note; staff see and edit the same details under
   **Stage details** on the event's planning page.

How it works:

- Templates and plans are rows keyed by library keys
  (`private.planning_library()`), separate from labels and order. A plan is a
  copy, so template edits never reach existing plans.
- Booking runs `private.ensure_event_plan` from a trigger on
  `booking_confirmed_at`, in the booking transaction (one plan per event,
  under the event lock, never overwritten). The migration backfills events
  already booked (Event basics only).
- The plan keeps an immutable copy of the signed contract's frozen proposal
  questions and submitted answers (`event_plan_imports`). Nothing is mapped
  into planning fields by guessing.
- Clients use `client_planning_view` and `client_save_plan_basics` with their
  own session: verified event access, booked, nothing archived. Payment
  corrections after booking keep access.
- Event basics needs guest count, start and end time, the venue (satisfied by
  the event's venue when staff entered one) and DJ access details (or an
  explicit "No special instructions", recorded as not applicable).

#### Stage details

Editors are chosen by stage key (`ceremony`, `cocktail`, `reception_entrance`,
`dinner`, `party`, `closing`), never by label, and save on the stage item, so
hiding a stage keeps its answers. The moments they cover (`ceremony_details`,
`cocktail_details`, `dinner_details`, `closing_instructions`) show "Included
in the details above". Fields are a fixed typed list
(`private.planning_editor_fields`), mirrored in `src/lib/planning/stages.ts`.

| Stage | Fields | Needed to complete |
|---|---|---|
| Ceremony | location (same as the event venue, or another place) and room/outdoor area; guest arrival, start, end; officiant name and contact; microphones (not needed / needed / not sure, discuss with DJ) and who speaks; instructions | location, start time, microphone needs ("discuss" stays open) |
| Cocktail | location and area; start, end; atmosphere or music style; instructions | location, start time |
| Reception entrance | guests enter; planned entrance time; "No formal entrance" | entrance time, or no formal entrance (not applicable) |
| Dinner | location and area; start, end; meal style; guest count (Event basics' count, or another number) | location, start time, guest count |
| Party | location and area; start, end; additional evening guests | location, start time |
| Closing | finish (a time, Event basics' end time, or discuss with DJ); closing instructions | finish time ("discuss" stays open) |

- Optional fields never block completion. "Same as the event venue" is the
  staff-entered venue, else Event basics' venue; until one exists it stays
  open. Reuse stores the choice, never a copy.
- Times are local to the event's time zone with an explicit "Next day" mark.
  Within a stage the end must come after the start; an earlier end without
  "Next day" is refused, never assumed. Unknown times are fine.
- `private.plan_timeline_warnings` compares visible stages in the staff's
  order and flags a stage that starts before the previous one starts or ends
  (and guest arrival or entrance order inside a stage). Times never reorder
  stages.
- No imported proposal answer is mapped into stage details: no question key
  has a documented meaning. They stay visible under "Already provided".
- Equipment answers (microphones) are planning information for the DJ to
  review; they never change the contracted package, gear or price.

#### Songs

Songs are typed in by hand: title and artist, with an optional version,
link and notes. There is no music service: nothing is searched, fetched or
played, and an optional link never replaces title and artist. Each editor is
chosen by moment key and opens as a card inside its stage, in the plan's
order; staff see the same editors under **Stage details and music**.

| Editor | Moments | Alternative to entering songs |
|---|---|---|
| Background music | `arrival_music`, `pre_ceremony_music`, `cocktail_music`, `dinner_music` | DJ's choice |
| Requests | `must_play`, `play_if_possible` | No requests |
| Do not play | `do_not_play` | Nothing to exclude |
| Moment songs (with an optional cue label and instructions per song) | `processional` (with who walks in, below), `couple_entrance`, `ceremony_signing`, `recessional`, `entrance_music`, `cake_cutting`, `first_dance`, `family_dances`, `other_dances`, `last_dances`, `final_song` | DJ's choice, Not applicable, Not sure (discuss with DJ) |

To try it: open **Plan your event**, open **Party**, then **Must play**. Use
**Add a song**, **Move up** / **Move down**, **Edit**, **Remove** (with
**Undo**) and reload. In **Play if possible**, open **Paste a list**, paste a
few lines (one with no dash) and **Preview**. Correct the flagged line, then
**Import**. Add a Must play song to **Do not play** to see the warning. On a
phone-sized window nothing should scroll sideways.

How it works:

- **Storage.** A list is saved on its moment item
  (`event_plan_responses.answers`, revision-checked, like stage details) as
  `{"songs": [...], "choice": "..."}`. A song has an `id` (a UUID made in the
  browser, unique in its list), `title`, `artist` and optional `version`,
  `link`, `notes` and, for moment songs, `cue`. The id is the only identity,
  never the title or position; order is the array order. No catalog table:
  the same title can be entered in several lists.
- **Validation** (`private.normalize_plan_music`, mirrored in
  `src/lib/planning/music.ts`). Title and artist are needed (200 characters
  each); version 100, cue 80, notes 500, link 1,000. Links must be
  `https://` with a host name and no credentials (`private.is_https_url`).
  They are shown as "Open link (host)", open in a new tab with
  `noopener noreferrer`, and are never fetched. A list holds up to 150 songs,
  a moment up to 12. Unknown fields, repeated or malformed ids and other
  editors' choices are refused.
- **Completion.** Each editor has one requirement: songs entered, or its
  explicit alternative (DJ's choice, No requests, Nothing to exclude).
  "Not applicable" counts as answered but keeps the moment in the plan;
  only staff hide or remove moments. "Discuss with DJ" stays open, even with
  songs. An alternative can't be chosen while songs are listed: remove them
  first, so nothing is lost silently. Versions, links and notes never block.
- **Concurrency.** The whole list saves with the item's revision, so a stale
  tab gets a conflict and overwrites nothing. A save identical to what is
  stored counts as saved even with an older revision, so a retried request
  or a doubled click never duplicates songs. Songs added while a save is
  pending are kept and saved next; a failed save keeps them and offers
  Retry.
- **Paste a list.** One song per line as `Artist - Title` (a hyphen, en
  dash or em dash with spaces around it). Blank lines and leading numbers or
  bullets are ignored. A line without a separator, or with more than one,
  is flagged. Flagged lines can't be imported until they are corrected or
  marked "Looks right". The preview gives every line its id up front, and
  importing closes the preview. The songs then save like typed ones, through
  the same validation and access checks.
- **Warnings** (informational; nothing is moved or removed). A repeated
  title and artist within a list, and the same song in a play list and in
  Do not play. Matching ignores case and spacing only: without a music
  service, recordings can't be identified.
- **Reception entrance.** **Entrance music** is the one place for its songs,
  with a cue per group ("Wedding party", "Couple"). **Introductions** link to
  them by entry id (see People below), so nothing is entered twice.
- **Hidden moments and stages** keep their songs. They are left out of the
  views and progress until restored. Archived events are read-only.
  Planning writes never touch contracts, prices, payments, booking or
  imported answers, and send no email.

#### People: participants, MC and speeches

Names and pronunciation guides are plain text (no recordings or speech
synthesis). Each editor opens as a card inside its stage, like songs.

| Moment | Editor | Each entry | Alternatives |
|---|---|---|---|
| Processional (Ceremony) | Its songs, then who walks in, in order, the couple included | Name or names (a person, a pair or a group, for example "Alex with their mother Dana"); role or relationship, pronunciation guide, instructions, a song from Processional or Couple entrance (all optional) | Discuss with DJ; the moment's "not applicable" covers both |
| Introductions (Reception entrance) | Everyone announced, in order | Names exactly as announced; role, pronunciation, introduction wording, instructions, an Entrance music song (all optional) | No introductions; discuss with DJ |
| MC (Reception entrance) | The DJ, someone else, no MC, discuss | Someone else: name (needed), pronunciation, phone or email, instructions | |
| Speeches and toasts (Dinner, Program or Party) | Speakers in order | Speaker; role, pronunciation; timing: an exact time, a moment ("After the main course") or not decided; minutes, microphone/AV notes, instructions (all optional) | No speeches; discuss with DJ |

To try it: in **Ceremony → Processional participants**, add two songs, then
use **Add person or group** with a song from the list. In **Reception
entrance**, add songs to **Entrance music**, then **Add introduction** and pick
one of them (two introductions can share a song). Try **Remove** on a linked
song (it's disabled, naming who uses it), rename it, and see the introduction
follow. Set the **MC**, and in **Dinner → Speeches and toasts** add speakers
with a time (tick **Next day** after midnight), a moment, or "Not decided yet".

How it works:

- **Where answers live.** One revision-checked row per moment, as for songs.
  Processional stores `{"songs", "choice", "participants", "participants_choice"}`;
  saving people keeps its songs and the reverse. Introductions and speeches
  store `{"entries", "choice"}`; the MC `{"mc", "name", "pronunciation",
  "contact", "notes"}` (someone else's details only while someone else is
  the MC). Entries have stable ids like songs.
- **One place each.** Whoever walks in at the ceremony, the couple
  included, is listed under Processional. Couple entrance keeps only its
  song, which the couple's Processional entry can link to. At the reception,
  **Introductions** is the participant editor: **Participants and names**
  shows "Included in Introductions", saves nothing and isn't counted. The MC's
  contact stays with the MC; a later contacts editor can read it from there.
- **Song links.** An entry stores only `song_id`. Processional entries can
  point at Processional's or Couple entrance's songs (same ceremony, same
  plan); introductions at Entrance music's.
  Titles, cues and order are read through the link, so renaming or
  reordering songs never rewrites names. On every save, under the plan row
  lock all plan saves take, the database refuses a link to anything else
  (another moment, another event, a removed song) and refuses removing a
  linked song (from Processional, Couple entrance or Entrance music), naming
  the entries using it. The UI disables **Remove** on a linked song and says
  where to change the link. A stale tab that removes one gets the refusal and
  can **Undo**. A hidden Couple entrance or Entrance music keeps its songs and
  the links; the entries show the song as not in the active plan.
- **Completion.** Processional needs songs (as before) and who walks in.
  Introductions need entries, or "No introductions" (not applicable). The MC
  needs the DJ, or someone else with a name; "No MC" is not applicable.
  Speeches need entries that each have a speaker and a time or a moment; an
  undecided timing keeps them open ("A speech has no time or cue yet"); "No
  speeches" is not applicable. "Discuss with DJ" always stays open.
  Alternatives are refused while entries exist, and never hide the moment.
  Roles, pronunciation, wording, contacts, durations and instructions never
  block.
- **Times.** A speech's exact time uses the stage time model: local to the
  event's time zone, "HH:MM" with an explicit **Next day**. A moment is just
  text, never turned into a clock time.
- **Saving.** Autosave as elsewhere: edits during a pending save are kept, a
  failed save keeps everything and offers Retry, a stale tab gets a
  conflict, and a retried identical save is never duplicated. Remove offers
  Undo. Microphone and AV notes are for the DJ to review; nothing changes
  contracts, gear, prices, payments, booking or imported answers.

#### Contacts, preferences and music styles

| Section | Editor | Needed to complete |
|---|---|---|
| Contacts and vendors (general) | Day-of contact: one of the event's contacts (by reference, with an optional phone for the day), someone else (name, phone, relationship), or "Not decided yet". Vendors in order: role (planner or coordinator, venue, photographer, videographer, caterer, live musician, other), person's name and/or business, optional phone, email and coordination notes shared with the client | A day-of contact with a phone; vendors listed, or "No additional vendor contacts" (not applicable) |
| DJ expectations and overall preferences (general) | Atmosphere and what matters most; DJ interaction (mostly music, occasional announcements, interactive, discuss); explicit lyrics (clean only, allowed, discuss); guest requests (welcome, never anything on Do not play; not welcome; discuss); practical preferences | Interaction, announcement language, lyrics and requests; "discuss" stays open |
| Music preferences (Party) | Styles (pop, dance, hip-hop and R&B, rock, disco and funk, country, Latin, house and electronic, throwbacks) and another style, or DJ's choice; favourite artists; dance-floor atmosphere; slow songs (DJ's choice, none, a few, discuss) | Styles or DJ's choice; a slow-song choice ("discuss" stays open) |

To try it: open **Contacts and vendors**. The MC and officiant appear under
"Already in your plan" without being entered again. Choose **One of the
event's contacts**, pick someone without a phone on file and add **Phone for
the day**. Add vendors, including one with a bad email, then reorder and
remove with **Undo**. In **DJ expectations**, the announcement language reads
"Not set yet" until it is chosen in **Event basics**. In **Party → Music
preferences**, pick styles (DJ's choice is disabled until they're cleared).

How it works:

- **Storage.** Each section saves on its item, revision-checked, like
  every planning editor (`contacts`, `preferences`, `music_style`).
  Vendors have stable ids; reordering, retries and stale tabs behave as
  elsewhere.
- **Event contacts by reference.** The views list this event's contacts
  (`event_clients` joined with `clients`, not archived) with name and phone
  only. Choosing one stores only its client id. Every save checks, under the
  plan lock, that the id is one of this event's current contacts, so another
  event's or another business's contact is refused. People are never
  matched or merged by name.
- **Planning never changes contacts.** A "phone for the day" lives only in
  the plan; the client's record, signer and event contacts stay as they are.
  If a chosen contact leaves the event or is archived, the choice is kept,
  shown as "isn't on this event any more", and the requirement reopens
  ("contact_unavailable"). It can't be saved again until another choice is
  made.
- **One place each.** The MC and officiant stay in their own editors and are
  shown read-only in Contacts. The announcement language lives only in Event
  basics; preferences read it from there and store no copy. Specific songs
  stay in Must play, Play if possible and Do not play.
- **Validation.** Phones: 7 to 20 digits with optional `+`, spaces, dots,
  dashes or brackets (`private.is_phone`). Emails: a plausible address
  (`private.is_email`); nothing is ever contacted. A vendor needs a role and
  a person's name or a business. Optional fields never block completion.
- **Privacy.** Coordination notes are labelled as shared with the client.
  Staff notes, staff identities, payment references and signing evidence are
  never in the client view. Preferences are for the DJ's review; nothing
  changes proposals, contracts, prices, payments or booking.

#### Arrival, program, activities and dedications

| Moment | Fields | Needed to complete |
|---|---|---|
| Arrival details (Guest arrival) | Location: same as the event venue, same as the ceremony, or another place, plus room or area; arrival time: same as the ceremony's guest arrival, or a start and end time; welcome instructions; announcement wording; or "No separate arrival arrangements" | Location and arrival time, each resolved; or "no separate arrangements" (not applicable) |
| Program details (Speeches and program) | Optional overall start and end, host and pronunciation, instructions; ordered agenda items: title, timing, minutes, presenter, pronunciation, instructions | Every item has a time or a moment; or "No formal program" (not applicable) |
| Activities (Dinner and Party, one shared editor) | Ordered activities: name (suggestions such as Shoe game, Bouquet toss or Centrepiece giveaway, or anything typed, such as a cultural tradition), timing, minutes, host, participants, pronunciation, instructions, optional song | Every activity has a time or a moment; or "No activities" |
| Dedications (Party) | Ordered dedications: for whom, relationship, pronunciation, announcement message, song, timing (any time during the party, a time, a moment or undecided), instructions | Every dedication has a song and a timing; or "No dedications" |

Timing everywhere is an exact time (local to the event, with an explicit
**Next day** after midnight), a moment such as "After dessert", or "Not
decided yet", which keeps the section open. "Discuss with DJ" also stays
open. Speeches, cake cutting, special dances and arrival music keep their own
cards.

To try it: staff add **Guest arrival** and **Speeches and program** (with
their detail moments) to a plan under Structure. As the client, in **Arrival
details** choose "Same as the ceremony" for the place and time. In **Program
details** add an agenda item with a time and one with a moment. In **Dinner →
Activities** add the Shoe game with a song. In **Party → Dedications** add one
without a song, and see it stay open until a song is added.

How it works:

- **Storage.** Each moment saves on its item, revision-checked
  (`arrival`, `program`, `activities`, `dedications`). Entries have stable
  ids; reordering, Undo, retries and stale tabs behave as elsewhere.
- **Arrival reuse is explicit.** `location_source` `ceremony` or
  `event_venue`, and `time_source` `ceremony`, store the choice, never a
  copy. They resolve when read from the visible Ceremony's details. While
  the Ceremony lacks them or is hidden, they stay open ("Not in the Ceremony
  details yet"). Ceremony guest arrival stays in the Ceremony; this card is
  for general arrival. Times are validated like stage details (the end after
  the start, after midnight only with **Next day**).
- **One song source per entry.** An activity's or dedication's song (title,
  artist, version, link) belongs to that entry; nothing links into other
  moments, so there are no cross-moment links to protect. A song needs both
  title and artist; links must be safe `https://` and are never fetched.
  Unfinished dedications are kept as entered: no song or time is invented.
- **Progress.** Every library item now has an editor. The stages that only
  hold moments (Guest arrival, Speeches and program, Special dances) aren't
  counted themselves, so nothing reads "Not available yet". Hidden sections
  keep their answers and leave progress. Times never reorder stages.

#### Planning deadline and reopening

The client can change planning until the event's **deadline**; after it,
planning is read-only for them ("Planning is read-only. Contact your DJ for
changes.") and every saved answer stays readable. Staff edit as before.

| Setting or action | Who | Limits |
|---|---|---|
| Business setting: days before the event (**Settings → Planning deadline**) | Owner | Whole days, 0 to 365 (0 closes at the start of the event day). Default 14. Versioned |
| Change this event's deadline (days before the event) | Staff | 0 to 365 days; a reason (1 to 500 characters) |
| Recalculate the deadline after the event's date or time zone changed | Staff | Explicit confirmation and a reason |
| Reopen client editing until a date and time | Staff | Only after the deadline; in the future, at most 14 days from now; event's local time; a reason |
| Close client editing now (ends a reopening early) | Staff | A reason. Never closes a plan before its deadline |

To try it: as the owner, open **Settings → Planning deadline**. On an event's
planning page, the **Client editing** card shows Open, Read-only or Reopened,
the deadline in the event's time zone, the actions above (each in a
confirmation explaining its effect) and the history with reasons and who.
The event page's Planning card shows the same state in one line. As the
client, the planning page says when editing closes, or that it is
read-only, or until when it was reopened.

How it works:

- **Deadline.** 00:00 in the event's time zone on the event date minus the
  plan's days. Where the clocks skip midnight that day (DST starting at
  midnight in some zones) it is the first moment of the day (01:00); where
  midnight happens twice, the first one. The event's start time plays no
  part. Shown everywhere with its time zone.
- **Established once.** When a plan is set up (booking, staff setup), it
  copies the business's days (`event_plans.client_cutoff_days`) and stores
  the deadline (`events.planning_lock_at`). Changing the setting affects plans
  set up afterwards only. Changing the event's date or time zone never moves
  it: staff see "no longer matches" with what the current schedule would give,
  and recalculate explicitly.
- **Database enforcement.** Both client write functions
  (`client_save_plan_item`, `client_save_plan_basics`) go through one gate
  that keeps the existing checks (verified access, booked, enabled item,
  nothing archived) and then compares the deadline and any reopening, read
  from the locked event and plan rows, with `clock_timestamp()` taken after
  the locks. A request that waited on a lock across the deadline is refused.
  A refusal returns `{"status":"locked","editing":{...}}` and changes
  nothing; it is checked before validation, so even invalid or stale input
  gets the lock. No scheduled job is involved. Staff saves have no deadline.
- **Reopening** (`events.planning_override_until`) is per event, never moves
  the deadline, ends by itself at its time (database clock), and never
  bypasses archiving or revoked access, which are checked first. Answers are
  never cleared.
- **Concurrency.** Deadline actions lock the event (no key update) and then
  the plan, the order every planning write uses, so they serialize with client
  saves (event share), archiving (event update) and each other. They check
  the plan's `client_cutoff_version`: a stale tab gets a conflict, while a
  repeated identical click is reported as unchanged. Direct column writes are
  revoked and a trigger refuses any change outside these functions.
- **History.** Each change writes an audit event with the staff user,
  database time, reason and before/after values. Clients never receive
  reasons, staff identities or versions: their view has only the state, the
  deadline, when editing closes and the time zone.
- **In the browser.** One editing state is shared by every editor. When a
  save comes back locked (a tab left open across the deadline), every editor
  turns read-only at once, nothing more is sent, and the unsaved input stays
  on screen marked "Not saved". The pages are `private, no-store` and every
  save is decided by the database, so a cached or stale page can't write.
- Nothing here changes progress, contracts, prices, payments, booking or
  emails, and it is not a frozen run sheet: staff can still edit.

#### DJ run sheet

Staff open **Run sheet** from the event page's Planning card or the planning
page. It is read-only (edit links go back to planning) and built for a phone
on gig night:

- **Header:** event, date, time zone, venue, "Latest saved plan as of"
  (database time) and a revision code, plus the client-editing state for
  context. Archived events are labelled and stay available to staff.
- **Essentials:** DJ service times from Event basics (next-day ends named),
  guests, day-of contact with a call link (a phone for the day overrides the
  contact's own), access and load-in, venue and room, MC with pronunciation,
  officiant; announcement language, explicit lyrics, guest requests and DJ
  interaction.
- **To check:** timing warnings, songs that are also on Do not play, stage
  times outside the DJ service times, and (folded under a count) what is
  still unanswered, per section.
- **Stages in your configured order:** times (exact, next day, "Not set"),
  location, instructions and details; then each moment's rows: names with
  pronunciation and announcement wording, linked songs with cue labels,
  versions and start/fade notes, speeches and activities with their exact
  time or cue ("Cue: After the main course", never a made-up clock time),
  durations and AV needs, and explicit choices ("DJ's choice", "Not
  applicable", "No introductions") kept distinct from "Not answered yet".
- **Music lists** collapsed by default so long playlists don't bury the
  cues; **Do not play** is linked from the top and open.

**Download run sheet PDF** generates the same content on demand: header and
gig overview (contacts, preferences, warnings, a time/cue, moment and people,
song, instructions table per stage with the column header repeated on each
page), then planning details (stage details, vendors, the frozen proposal
answers under their own heading) and the full music lists in order. Pages
are numbered, and the footer repeats the revision and the as-of time.

How it works:

- **One projection** (`src/lib/run-sheet/model.ts`) is shared by the page
  and the PDF. It reads one `staff_planning_view` call: a STABLE function, so
  every answer, revision and song link comes from one database snapshot even
  during concurrent saves. Hidden stages and moments are left out. Reuse is
  resolved from what was saved: "same as the event venue", the guest count
  and end time from Event basics, the ceremony's place and arrival time,
  Processional and Introductions links to Couple entrance and Entrance music
  songs. People sharing one linked song are grouped so the song shows once,
  and Entrance music only lists songs not already shown with an
  introduction. Nothing is written; nothing comes from browser form state or
  the current catalog.
- **Revision:** a short hash of the projected content, so exports made
  before and after an edit differ, and an unchanged plan gives the same
  code. Staff changes after the client deadline appear on the next refresh.
- **Access:** the page and `/run-sheet/pdf` recheck the staff session and
  membership on every request (RLS and the planning functions decide).
  Signed-out visitors, clients and other businesses get a 404; the PDF is
  streamed with `private, no-store` and never stored. Internal event notes,
  payments, signing evidence, client emails, audit reasons and staff
  identities are not part of the projection.
- It is a working document from the latest saved plan, never a contract
  and never "final": staff can still change the plan after the client
  deadline.

#### Inviting a DJ

Platform administration is a separate grant, never part of a business role
(see "DJ invitations and new workspaces"). To try it locally, grant one of
your local identities once (it needs a verified email, as the seeded owners
have):

```bash
docker exec -i supabase_db_flux-dj psql -U postgres -c \
  "select private.grant_platform_admin('owner@bouprod.example', 'Local operator');"
```

1. Sign in as that user and open http://127.0.0.1:3000/platform/invitations
   (also linked as **DJ invitations** in the staff header).
2. Enter an address, click **Review invitation**, check the recipient and
   expiry, then **Send invitation**.
3. In Mailpit, open "You're invited to set up your DJ business on Flux DJ" in
   a private window and click **Accept the invitation**, then **Email me a
   sign-in link**.
4. Open "Confirm your email to set up Flux DJ", click **Confirm and
   continue**, then **Sign in**.
5. Enter a business name and web address and click **Create my workspace**.
   You land on the new, empty workspace with a welcome message.

Revoke the local grant with `select private.revoke_platform_admin('…');`.

#### Suspending a workspace

With a local platform administrator (above) who does not belong to the
workspace you suspend (an administrator can't suspend their own; use a
throwaway workspace created through an invitation, never BOUPROD):

1. Open http://127.0.0.1:3000/platform/workspaces and click **Suspend…** on
   the workspace. Read the effects, enter an internal reason and click
   **Suspend workspace**. It shows **Suspended** with the time, who did it and
   the reason.
2. In another browser signed in as that workspace's owner, reload any staff
   page: it shows "This workspace is unavailable", with no reason. A client's
   proposal page or emailed proposal link says it is temporarily unavailable.
3. Click **Restore…**, enter a reason and click **Restore workspace**. The
   owner's and client's pages work again; nothing is emailed.

#### Branding

1. As an owner, open **Settings** and scroll to **Branding**.
2. Choose a PNG, JPEG or WebP logo and a primary colour. The preview beside
   the form updates at once (nothing is saved or sent yet).
3. Click **Save branding**. The header shows the logo instead of the
   business name; client contract and planning pages, and proposals sent
   from now on, use the logo and colour.
4. Check another business (for example Other DJ) still shows its own name or
   logo, and that **Remove the logo** brings the name back.

#### Installing Flux DJ on a phone

Flux DJ can be added to a phone's home screen and opens without browser
controls. It is the same website, always online: nothing is stored for
offline use and there is no service worker.

- **One app for everyone:** "Flux DJ" (`app/manifest.ts`), opening at the
  neutral `/start`, scoped to the whole site. `/start` sends signed-out people
  to sign in and everyone else to `/staff`, which already routes staff to
  their business (or the chooser) and clients to `/my`. No business, event,
  token or personal data is in the manifest, start URL or icons. Inside the
  app each DJ's pages keep their own branding.
- **Icons:** the supplied Flux app icon (`assets/brand/flux-app-icon.png`,
  1080 x 1080) is scaled, never redrawn, by `node scripts/generate-app-icons.mjs`
  into the 180 Apple touch icon, the 192 and 512 icons (rounded corners), a
  maskable 512 (padded with the icon's own background so the artwork stays
  inside the safe circle) and the 16/32/48 favicon. The outputs are committed;
  builds never run the script. To change the icon, replace the source (any
  square, ideally 1024 px or more) and run the script again; it warns if it
  would upscale. Installed iPhone apps keep their old icon until they are
  removed and added to the Home Screen again.
- **Install help:** a quiet one-line strip on the staff dashboard and a small
  card on `/my`. It
  offers the browser's own install prompt where there is one (Chrome, Edge,
  Android), explains Safari → Share → Add to Home Screen on iPhone and iPad
  (and to open Safari from other iPhone browsers), shows nothing elsewhere,
  and never appears inside the installed app. "Not now" hides it for good on
  that device (a single `localStorage` flag; no private data).
- **Signing in from the app:** emailed links open in the phone's browser, and
  on iPhone an app added to the Home Screen does not share Safari's sign-in.
  So the same email also carries a 6-digit code: type it on the app's sign-in
  page ("Sign in with code"). The link keeps its explicit "Sign in" step. No
  password, and nothing about the sign-in is kept in browser storage. Code
  attempts are limited per IP (`sign_in_code`), on top of Supabase's own
  limits.
- **Standalone use:** zoom stays available; the default viewport keeps pages
  inside the notch and home-indicator safe areas. Every page offers a way on
  without a Back button (staff navigation, "Your events and contracts" on
  client pages, and a "Go to Flux DJ" link on not-found pages). PDFs (run
  sheet, signed contracts) open the phone's share options (save to Files,
  print) from the app instead of a viewer with no way back; in a browser they
  download as before. When the device is offline a notice says pages may be
  out of date and changes can't be saved.

## Running the checks

```bash
pnpm check
```

This runs, in order:

| Step | Command | Needs Docker |
|---|---|---|
| ESLint | `pnpm lint` | No |
| TypeScript | `pnpm typecheck` | No |
| Pricing unit tests (Vitest) | `pnpm test:unit` | No |
| Postgres schema lint | `pnpm db:lint` | Yes |
| Database tests (pgTAP) | `pnpm db:test` | Yes |
| Integration tests (Vitest) | `pnpm test:integration` | Yes, with the Storage service running |
| Browser tests (Playwright) | `pnpm test:e2e` | Yes. It starts `pnpm dev` if it isn't running |

Before the first browser test run, install the browser once with
`pnpm exec playwright install chromium`.

Tests never write to the seeded BOUPROD or Other DJ tenants, so your manual
work there is safe while they run.
- Browser tests create their own tenants (`e2e-…`) with the DEMO catalog
  copied from the seed (`tests/e2e/tenant.ts`).
- Integration tests create their own tenants (`it-…`).
- Each test tenant's only member is a throwaway `@example.test` owner, so it
  never appears in your staff workspace. It is archived when the suite ends.
- Proposals, contracts and audit rows are immutable, so test tenants are
  archived rather than deleted. `pnpm db:reset` removes them along with
  everything else.

`pnpm build` also verifies the production build. It is safe while `pnpm dev`
is running: Next.js 16 writes development output to `.next/dev` and builds
to `.next`, and a build's cleanup keeps `.next/dev`. Run the build with
`next start` stopped (`next start` serves `.next`).

### Day-to-day testing

Run the smallest check that covers the change, and the whole suite once.

| While you… | Run |
|---|---|
| Work on one browser test | `pnpm test:e2e tests/e2e/planning-flow.spec.ts:342` (the test's line) |
| Work on one browser spec | `pnpm test:e2e tests/e2e/planning-flow.spec.ts` |
| Rerun only what just failed | `pnpm test:e2e --last-failed` |
| Need screenshots for review | `E2E_SCREENSHOTS=1 pnpm test:e2e <spec>` (PNG files under `test-results/`) |
| Change unit-tested code | `pnpm test:unit` (about a second), or `pnpm exec vitest related --run <changed files>` |
| Change server code with integration tests | `pnpm test:integration tests/integration/planning.test.ts`, or `pnpm test:integration --changed` |
| Change SQL | `pnpm db:test` (pgTAP, about 12 seconds) and `pnpm db:lint` |
| Restarted local Supabase | `pnpm db:versions` (local must match the hosted versions) |
| Are about to deliver or deploy | `pnpm check` once, then `pnpm build` |

1. Run targeted tests during implementation, and rerun only the failing
   test after each fix.
2. Run the affected suites once the feature is stable.
3. Run `pnpm check` once before delivery or deployment. Repeat broad checks
   only after further changes or for an unresolved failure.

Most browser specs are `describe.serial`: later tests build on earlier ones.
Selecting a single test that depends on earlier ones (by line or `-g`) skips
those earlier tests, so it fails for the wrong reason. In that case, run the
spec. Failures always keep a screenshot and a trace in `test-results/`
(`pnpm exec playwright show-trace <trace.zip>`), so you never need to rerun a
spec just to see what happened.

**Sign-in and rate limits.** The app limits sign-in requests per IP
(`sign_in_link`: 30 per 10 minutes at `/login`; `sign_in_code`: 20 code
attempts per 15 minutes at `/login`; `contract_sign_in`: 10 per 15 minutes on
the contract invitation page). Every local browser comes from
127.0.0.1, so the tests share these limits with your own browser.

- Feature specs sign in with `signInStaff`, `signInWithLink` or
  `verifyContractInvitation` (`tests/e2e/support.ts`). These create a real
  single-use Supabase link, exactly as the contract verification email does,
  and open it through the real `/auth/confirm` page. The session, routes
  and RLS are real. Only requesting the link through a form and reading it
  from Mailpit are skipped, so these specs use no rate-limit budget and can
  run repeatedly.
- Only `staff-flow.spec.ts` (login form, unknown emails, link scanners,
  JavaScript off, sign-in with the emailed code), `contract-send-flow.spec.ts`
  (invitation request, verification, returning-client login) and
  `platform-onboarding-flow.spec.ts` (the DJ invitation request) use the real
  forms. A full run uses 5 `sign_in_link`, 2 `sign_in_code`, 1
  `contract_sign_in`, 2 `platform_sign_in` (10 per 15 minutes) and 3
  `workspace_create` (20 per 15 minutes).
- If a limit is used up, the test fails at once with the limit's name and the
  time it resets. Nothing resets the counters, and production limits are
  unchanged. The limiter itself is proven by the pgTAP tests (`12_…`, `17_…`).

**Test data.** Each spec or suite creates its own `e2e-…` or `it-…` tenants
and archives them when it ends, even after a failure. Integration suites
first give up their tenants' leftover signed-PDF jobs, so neither the
scheduled worker nor `pnpm outbox:work` spends time on them before real jobs.
Archived tenants never send email. Specs that need a PDF claim only their own
contract's job.

Keep `workers: 1`. Specs share the per-IP limits, Mailpit and the dev server,
so parallel runs would trade a little time for flaky failures.

**Long runs and logs.** A full browser run takes about 3.5 minutes. To keep a
log, redirect to a file and read it while it runs, rather than piping through
`tail` (which shows nothing until the end):

```bash
pnpm test:e2e > /tmp/e2e.log 2>&1; echo "exit $?"
```

A pipe reports the last command's status. If you pipe test output through
`grep`, `tail` or `tee`, run `set -o pipefail` (zsh: `setopt pipefail`) first
so a failure still exits non-zero.

### Database tests

The tests in `supabase/tests/database/` run against the real local Postgres
with real RLS. Each file switches to the `authenticated` or `anon` role with
JWT claims, as PostgREST does, and rolls everything back afterwards. Nothing
is mocked. Shared fixtures in `_fixtures.psql` create two tenants and users
in every relevant relationship.

| File | Proves |
|---|---|
| `01_schema_guards` | RLS is on for every table; anon has no grants; security definer functions pin `search_path`; no RLS-bypassing views; the client projection omits staff fields |
| `02_staff_tenant_isolation` | Staff of tenant A cannot SELECT, INSERT, UPDATE or DELETE tenant B rows; `tenant_id` cannot change, even for privileged code |
| `03_integrity_constraints` | Composite foreign keys block cross-tenant references even when RLS is bypassed; one primary contact and one signer per event; access revocation is one-way; value validation |
| `04_membership_and_privileges` | Staff cannot escalate; owners manage staff only in their own tenant; lifecycle and access columns are not directly writable |
| `05_client_access` | A verified client sees only their linked events, including at two different DJs; unverified, revoked or email-only matches grant nothing; clients cannot alter staff data |
| `06_anonymous_access` | Anon has no table or function access |
| `07_catalog_isolation` | Every catalog and template table is visible and writable only by staff of the owning tenant; clients and anon get nothing |
| `08_catalog_integrity` | Cross-tenant composite keys for package contents, rules, templates and media; the default package must belong to its template; at most three packages per template; immutable keys; rule conditions limited to equality and membership, and checked against the question's options; media type, extension and path checks |
| `12_send_submit_approve` | Send authorization, stale versions and missing contacts; staff can't see token hashes or sessions. Link exchange across tenants, unknown, revoked and superseded links. Safe client view, draft conflicts and invalid input. Submissions with omitted required gear, out-of-range quantities, missing answers or tampered prices, stale tabs, idempotency, approval, revision, expiry while open, the outbox and rate limits |
| `15_event_archiving` | Only staff of the event's tenant can archive or unarchive, never directly. Links and sessions are revoked and pending client emails cancelled, while history and lifecycle status stay. Viewing, saving, submitting, link exchange, sending, approval and contract generation are blocked while archived. Unarchiving is audited and doesn't resurrect links |
| `17_contract_sending_client_access` | Send authorization, eligibility, idempotency and frozen content. Only `send_contract` can send, and generation is blocked while a contract is sent. The invitation token is hashed and scoped, and only asks for verification emails, rate limited. Wrong, unverified and multi-tenant accounts. Idempotent acceptance with no staff membership. Safe DTO fields, no leakage, client and anon reads. Dispatch rechecks. Resend, void and replacement with access kept. Archive and unarchive. Revised offers void sent contracts. Expired invitations |
| `18_contract_void_notice` | One notice per voided sent contract, none on repeats. Frozen signer, no link, no reason. Cancelled invitation emails. Memberships, identities, access and other events untouched. Deliverable at dispatch. Archiving neither sends nor cancels it. Revised-offer voids notify. Unsent drafts never do |
| `19_tax_settings` | Owner-only tax settings for staff, other tenants, clients and anon; no direct column writes. Malformed, fractional, negative and over-100% rates, codes, names, keys and unknown taxes. Stale versions. Multiple taxes on standard. Removal rules for used taxes and categories. Explicit no tax versus missing. New offers read the new settings; the sent snapshot and hash are unchanged. Audit |
| `20_contract_signing` | Only the service role signs. Wrong signer, other event's client, staff, stranger, no identity, wrong tenant, unverified or changed email, revoked access, archived event. Consent, consent version, displayed hash, typed name, never-stored, wrong-size, non-PNG, oversized and out-of-folder images. The atomic signed state and evidence, one audit event, no booking. Replays return the first signature to the signer only. Immutable evidence and content; void, resend, regeneration and revisions refused. Client and staff reads, Storage visibility, orphans. Archiving keeps evidence. Void and superseded contracts can't be signed |
| `22_client_use_signing` | Usage is required when publishing; legacy can't be chosen. Client use is owner-only, needs the current statement, and stores the exact statement, owner and database time; staff publish DEMO only; other tenants get nothing. Published usage and confirmation are immutable; drafts carry none; a new version copies text, not usage. Contracts freeze mode and consent, immutably. Signing with `client-v1` (the DEMO consent is refused) and exact evidence; `demo-v1` unchanged. Legacy versions can't generate; `none` contracts can't be sent or signed and the review explains how to regenerate. Signed-copy senders are frozen when queued and at the first attempt, never change, keep older rows' first values, ignore sent rows and are service-role only |
| `23_manual_payments` | Owner and staff record; other tenants, clients and anon can't, and no role writes rows directly. Amount, date, reference validation. Idempotent replays, reused keys, duplicate confirmation, exact cents. Invalidation with reasons, preserved history, immutability, audit. Drafts give no terms; sent terms; void and replacement without double counting; signed terms frozen after business, tax and catalog changes; overpayment as credit; zero-percent deposit. Client summary fields, other clients, void contracts, staff and anon. HTTPS invoice links, stale versions, unsafe URLs. Archiving blocks writes and the client view. No email, status, booking or contract change |
| `26_stage_details` | Library editors and covered moments; validation (times, explicit next day, impossible and equal intervals, choices, limits, unknown fields, conflicting entrance answers); partial answers and normalization; completion with venue and Event basics reuse, not applicable and "discuss with DJ"; overnight party and closing; chronology warnings in staff order without reordering; hidden stages keep answers; covered moments; Simple Party; other clients, other events' items, other businesses, anon and archived events; staff saves; no staff identity, payment references or notes for clients; contract, booking, payments, proposal and imports untouched; the Event basics entry point kept |
| `27_music` | Music editors by moment key and Entrance music as the single source for reception entrance songs. Song validation: title and artist needed, limits, https links without credentials, unknown fields, cues on moment songs only, repeated or malformed ids, list and moment limits. Choices per editor; alternatives refused while songs exist. Completion: songs, DJ's choice, No requests, Nothing to exclude, not applicable without changing the structure, discuss with DJ open even with songs. Order kept by id. An identical retried import is saved once; a stale different list conflicts; a concurrent identical first save is the same save; stage details keep strict revisions. Hidden lists and stages keep their songs and leave views and progress. Other clients, other events' items, other businesses, anon and archived events; staff edits. Contract, booking, payments, proposal and imports untouched |
| `28_participants` | Editors by moment key and Participants and names covered by Introductions (not saved, not counted); speeches wherever the library allows. Processional people saved with its songs: individual, pair and group entries without fixed labels, trimmed names and pronunciation in order, links to its own or Couple entrance songs only (another stage's or another event's refused), linked songs not removable from either (also from a stale revision), Couple entrance renames and hiding keeping links, not applicable refused while people exist, renamed and reordered songs leaving people untouched, discuss open. Introductions sharing Entrance music songs; links to another moment, another event or malformed ids refused; removing a linked song refused naming the entries, also from a stale revision; renames, reorders and unlinked removals allowed; hidden Entrance music keeping valid links; No introductions and discuss. MC choices, details kept only for someone else. Speech timing (exact time, next day, cue, undecided), bounds, completion. Retried adds saved once; hidden moments; other clients, other events, other businesses, anon and archived events; staff edits; contract, booking, payments, proposal and imports untouched |
| `29_contacts_preferences` | Editors on their sections; this event's contacts in the view with name and phone only. Day-of contact: not decided (open), someone else needing a phone, phone checks, an event contact by id only (no copy), a phone for the day without changing the client, contacts of another event or business and names refused, a contact leaving the event (kept, unavailable, not resaved). Vendors: name or business, roles, phone and email checks, order, none refused while listed, retried adds once, stale conflicts. Preferences: no language copy, language from Event basics, discuss open, unknown questions refused. Music styles: list order once, unknown styles, DJ's choice exclusive, other style, slow songs. Hidden sections, other clients, events and businesses, anon, archived events, staff edits; no staff ids, notes, payment references or signing evidence; clients, event contacts and contractual records untouched |
| `30_remaining_editors` | Editors in their library places (Dinner and Party sharing one); only moment-holding stages without an editor; nothing "not available". Arrival: ceremony reuse storing no copy, open while the Ceremony lacks it or is hidden, other place with overnight times and next day, event venue unknown, "no separate arrangements" refused with details and alone not applicable. Program: own times, agenda with exact, overnight, cue and undecided timings, titles needed, "No formal program" refused with entries. Activities: songs need title and artist and safe links, custom names, Party counted separately, stale tabs, unknown fields. Dedications: unfinished kept without invented songs, any time, songs needed, no durations, "No dedications". Retried adds once, stale conflicts, hidden stages, other clients, events and businesses, anon, archived events, staff edits, stage order unchanged; contractual records untouched |
| `33_platform_invitations` | Only the database owner grants platform administration (not the app, the API or the service role), only to one verified identity, audited. Tenant owners, staff, clients, strangers, anon and unverified administrators can't invite, list, resend or revoke; administrators see no business, client, event or email. Normalized addresses, one open invitation per address (also enforced by a unique index), hashed tokens only, emails with no tenant and only the link id. The tenant worker never claims them. Resend limits, link rotation, cancelled queued emails, audit. Verification requests: service role only, old and malformed links, masked address, 3 per 15 minutes, invited address only. Wrong, unverified, revoked and expired accounts and invitations. Names, reserved and malformed addresses, existing businesses (untouched, invitation still open). One business and one owner membership for the signed-in user, defaults, an empty workspace, replays returning the same workspace, final accepted invitations, no deletes. Existing clients and staff keep their access; other owners see nothing. Archived businesses keep their address and a retry never creates another |
| `34_workspace_suspension` | Only platform administrators suspend, restore or list workspaces (owners, staff, clients, strangers and anon can't); the suspension columns can't be written directly by any role. Reasons required, stale versions (PT409), repeats, and an administrator can't suspend their own workspace. While suspended: staff of the workspace read and write nothing (tables, settings, payments, planning, proposals, contracts, PDF requests, private media and uploads), learning only that it is suspended; staff of other businesses and strangers get the usual refusals; other businesses unaffected. Clients: events of the other business kept, contracts, invitations, signing, signed PDFs, signature images, payment summaries and planning unavailable. Proposal links open no session; sessions show and save nothing; expired sessions stay invalid. Every write refused for every role, including the service role, except the audit log. Undelivered emails cancelled (no reason in them), nothing claimed, a claimed email stopped before sending, other businesses' emails delivered. PDF jobs not claimed; a racing commit pauses without losing an attempt. Archiving stays independent. Restore: audited, sends and revives nothing, PDF job resumes, contracts, signatures, bookings, deadlines and payments unchanged, access back, revoked and expired links still invalid, no extended expiry |
| `35_business_branding` | Logos are registered only by the service role after the app's checks, only for the business's owner, only when the stored PNG exists with the declared size, under the business's own folder; registered logos are immutable. Staff, other owners, clients and anon can't change branding; nobody writes the logo or colour columns directly, and even privileged code can only activate a registered logo of the same business. Stale versions (PT409), colour format, another business's logo, normalization, kept colours, audit. Logo rows readable by the business's staff only; client pages get the live logo and colour of that business only. Sent proposals keep their logo and colour after replacement and removal; the frozen logo and its file stay; unused and unregistered logos are listed for clean-up. Suspended businesses can't change branding or add logos; archived ones follow their existing rules |
| `32_version_conflicts` | No function raises `serialization_failure` (40001); every optimistic-version check raises `PT409`; the re-created functions keep their grants |
| `31_planning_cutoff` | Owner-only, versioned setting with limits (staff, other businesses, clients, anon, direct column writes). Plans copy the days and store the deadline at setup; later setting changes leave them; a deadline already on the event is kept. Midnight in the event's zone: DST start and end days in Toronto, skipped and repeated midnight (Havana, Beirut), quarter-hour offsets, 0 days, zones east of UTC, events without a start time. States a microsecond before, exactly at and after the deadline and a reopening's end. Client view fields; saves before; after: reads continue, both save functions refused before validation and revision checks, nothing changed, progress unchanged; staff saves continue. Reopening: already open, reason, future, 14-day maximum, stale version, clients, other businesses, anon; stored expiry, deadline kept, client saves, replays, audit (staff, time, reason, before/after), nothing leaked to clients, staff history; expiry; closing early, repeats, never closing an open plan. Deadline changes and stale tabs; date and zone changes don't move it, mismatch shown, explicit recalculation. Direct writes and the trigger; archived and revoked access during a reopening; other clients and slugs; every plan has a deadline; booking and emails untouched |
| `25_planning` | Read-only tables for staff; starter templates added explicitly and once; template ownership across businesses, clients and direct writes; rename, move, remove and add with stable keys and versions; library placement enforced by trigger; duplicate and archive; one default per event type. Booking (real signing and deposit) creates one plan from the event-type default; the Basics fallback; setup before booking kept at booking; repeats and already-booked backfill. Frozen imports after catalog changes. Client access: booked, unbooked, other client, stranger, wrong slug, revoked, unverified, two DJs, anon, archived and unarchived, payment invalidation. Basics validation, conflicts, normalization, progress (imported and not applicable versus unanswered, unavailable sections excluded). Disable and restore keep answers and order and change nothing contractual. Non-destructive template replacement. Integrity |
| `24_booking` | Owner-only, versioned policy setting; no direct writes; only two policies. Frozen policy per contract, unchanged by later setting changes. On signature: booked when signed, with payment still due. On deposit: payments before signing count, partial payments await the deposit to the cent, the completing payment books, later payments and checks don't book again (one audit event, one email). Zero deposit. Overpayment. Corrections keep the booking and `booking_confirmed_at` and warn staff; the client sees the amount outstanding. Legacy contracts: nothing automatic, staff check as `on_deposit` (not the business's on_signature), then automatic. Archived events refused. Guards against booking outside the function, changing the date or unbooking. Tenant isolation. Older workers never claim booking emails |
| `21_signed_contract_pdfs` | Signing queues one PDF job (none on replay) and no email. Only the service role runs jobs. Leases: no double claim, expired-lease recovery, stale leases can't fail a job. Commit validation (missing, wrong size, wrong type, wrong folder, wrong signature hash). One canonical immutable document; a second upload is "exists" with no duplicate emails. One email per party with separate dedup keys, no paths or tokens in payloads. Staff, other tenants, signer, other clients and anon. Archiving blocks the signer and cancels undelivered copies but keeps the PDF. Recipient-confirmed resend that never repeats a delivered copy. Contracts signed before PDFs: explicit generation without email |
| `16_business_settings_send_review` | Owner-only settings for staff, other tenants, clients and anon. Validation and 0% and 100% boundaries. Half-up deposit rounding, and equality with the original 50% formula. Existing contracts are byte-for-byte unchanged with valid hashes. Explicit regeneration freezes new terms and identity. New placeholders and missing values. Every review rejection reason. Sending stays impossible |
| `13_contract_templates` | Templates are visible and writable only by staff of their tenant; clients and anon get nothing. Unknown, malformed or expression-like placeholders are rejected, also by a CHECK constraint. Optimistic draft versions, publishing, and published versions that no role can edit, unpublish or delete. Editing opens one new draft version |
| `14_contract_generation` | Deposit rounding. Authorization for other tenants, clients, strangers and anon. Unpublished and other tenants' template versions. Missing values listed with what to complete, and no signer. Amounts and lines from the approved selection, the documented hash, no booking and no access. Repeat clicks, explicit replacement and conflicts. Snapshot independence after client, event, business, tax, catalog and template changes. Frozen rows, cross-tenant foreign keys with the guard trigger disabled, literal rendering of client values, and superseded approvals |
| `09_storage_gear_media` | Storage policies on the `gear-media` bucket: private bucket, tenant-scoped reads, uploads only under the uploader's own gear items, no overwrite or delete |

| `10_offer_snapshots` | Offer creation rules: exactly three distinct packages and one most popular; every referenced package, gear item and question is active; only active rules of offered questions are frozen; every tax category resolves. Also covers authorization, template prefill, and snapshots and hashes that survive every catalog, tax and branding change |
| `11_selection_recording` | Only the service role records selections; optimistic versions; immutable selections and lines. The database rejects tampered prices, line totals, subtotals, tax rates, tax rounding, currency, offer hash and packages |

`_catalog_fixtures.psql` adds catalog rows and Storage objects for both test
tenants. `_offer_fixtures.psql` adds a third package and an offer-input
helper.

The selection tests force deferred constraint checks with
`set constraints all immediate`. The test transaction never commits, so
otherwise those checks would never run.

### Unit tests

`tests/unit/pricing.test.ts` covers the pricing module:

- The spec's speaker example, and charging required gear once when the
  client also selects it as an addon.
- Addon quantity bounds, missing answers and invalid selections.
- Rejection of client-supplied prices and totals.
- Half-up tax rounding per line, and determinism.
- Offer-snapshot validation.

### Browser tests

`tests/e2e/staff-flow.spec.ts` drives the real UI in Chromium:

1. It signs in through a real magic link read from Mailpit, and confirms
   unknown emails get no link and no account.
2. It confirms the other tenant's workspace returns 404.
3. It creates gear, changes its price, and uploads a real PNG. It then
   confirms that HTML renamed to `.png` is rejected and deleted from Storage.
4. It builds a package, a question with a rule, and a template, then creates
   an event with a new client.
5. It opens a proposal draft and checks the spec's speaker example in the
   live preview, a total of $2,701.91.
6. It saves the draft twice. It checks that the same row was updated, that
   nothing froze, and that a stale tab gets a conflict message.
7. It checks the preview has no sideways scrolling at 390px wide, and that
   signed-out visitors are redirected to login.

Browser tests in `tests/e2e/proposal-flow.spec.ts` run the client side in a
signed-out browser:

1. Staff must save before sending, and the confirmation shows recipient,
   event and expiry.
2. The emailed link opens on a clean URL with the recommended selections.
3. Required gear has a minimum the client can't go below.
4. Edits made while a save is pending survive. A failed save shows Retry.
5. A catalog price change doesn't affect the sent terms. The page fits a
   phone screen.
6. Double-clicking Submit creates one submission.
7. Staff review and approve. The client is told the contract follows.
8. The link grants no staff, event or direct database access.
9. A revision supersedes the old link and session.
10. Invalid and cross-tenant links show generic messages.
11. Expiry while the page is open blocks submission.

### Contract tests

- `tests/unit/contract-templates.test.ts` covers the "## Heading" editor
  format, the DEMO text markers and the error messages.
- `tests/integration/contracts.test.ts` runs through PostgREST with real
  sessions. It checks that the DEMO text is accepted, and that contract
  amounts equal the TypeScript pricing engine's. Two simultaneous generations
  create one draft. Later catalog, client and event edits leave the contract
  unchanged. Other tenants, the event's own verified client and anonymous
  REST calls get nothing.
- `tests/e2e/contract-flow.spec.ts` drives the staff UI. It covers
  publishing a template with a rejected placeholder, approving a real
  submission, missing-information guidance, and generation with a
  double-click. It checks the preview, including a client name with markup
  shown literally, and the layout at 390px with no sideways scrolling. It
  also covers confirmed replacement, signed-out redirects and 404s for the
  other DJ.

### Signed PDF tests

- `tests/unit/contract-pdf.test.ts` renders a long French agreement
  (multiline addresses, accents, 14 sections, signature) and a short one,
  checks the extracted text page by page (page numbers, DEMO labels, parties,
  terms, both hashes, consent, IP or "Not recorded"), checks that the PDF does
  not contain its own hash, and writes every page as PNG to
  `test-results/pdf-samples/` for visual review. A client-use agreement has no
  DEMO wording and still says only the client signed; DEMO labels follow the
  frozen signing mode, not the title.
- `tests/integration/contract-documents.test.ts` uses real rendering, Storage
  and the outbox. It covers:
  - frozen content after source records change
  - renderer and upload failures with recovery
  - a worker that dies after uploading (expired lease, orphan)
  - a stale worker losing the race
  - three parallel workers
  - signature and final-PDF hash mismatches
  - identical attachments to both parties with a per-recipient retry
  - a client-use contract signed with `client-v1`, rendered without DEMO
  - a signed-copy retry through the real Resend adapter (HTTP answered
    locally) after Business settings change: same idempotency key, headers
    and body byte for byte, with the original sender
  - private Storage
- `tests/e2e/contract-signing-flow.spec.ts` continues after signing: both
  emails arrive in Mailpit with the same PDF attached (hash checked), the
  signer and staff download identical bytes with private headers, and
  signed-out and other-tenant requests get no PDF.

### Signing tests

- `tests/unit/signature-image.test.ts` covers the PNG validator (blank,
  tiny, filled, palette, 16-bit, interlaced, bad CRC, trailing bytes,
  decompression bombs, SVG and JPEG, size limits), clean re-encoding, and
  trusted IP capture.
- `tests/integration/contract-signing.test.ts` runs against real Storage and
  Postgres: the stored bytes match the evidence hash, Storage access for staff,
  other tenants, the client and anon, replays after a lost response,
  concurrent attempts, expired sessions, failed uploads, a void or revision
  winning the race before the commit, a crash leaving only an unreadable
  orphan, and real sign-versus-void races.
- `tests/e2e/contract-signing-flow.spec.ts` signs on a phone-sized browser
  with touch input: validation, clear, scroll and rotation without losing the
  drawing, a failed request that keeps every input, consent and confirmation,
  then the signed views for the client and staff.
- `tests/e2e/client-use-signing.spec.ts`: the owner publishes their own
  agreement for client use (publish stays disabled until the responsibility
  statement is checked), generates and sends a contract, and the verified
  client signs with the `client-v1` consent. No DEMO wording appears on the
  page or in the emailed PDF.

### Planning tests

- `supabase/tests/database/25_planning.test.sql`,
  `26_stage_details.test.sql`, `27_music.test.sql`,
  `28_participants.test.sql`, `29_contacts_preferences.test.sql` and
  `30_remaining_editors.test.sql` cover the rules (see the table above).
- `tests/unit/planning-stages.test.ts`: the browser-side stage validation
  (next day, impossible intervals, bounds, normalization).
- `tests/unit/planning-music.test.ts`: the browser-side song validation,
  answers compared regardless of key order, the paste parser and its flags,
  duplicate and play / do-not-play matching, and views from a database
  without music editors.
- `tests/unit/planning-participants.test.ts`: the browser-side validation
  of Processional people, introductions, speeches (timing fields, next day,
  durations) and the MC, round trips, and song-link lookups.
- `tests/unit/planning-timed.test.ts`: arrival reuse and overnight times,
  timed entries (timing fields, songs, links, durations, choices),
  dedications' any-time timing and round trips.
- `tests/e2e/remaining-flow.spec.ts`: on a phone, arrival reusing the
  ceremony then its own overnight times; a program agenda with a time and a
  moment, reorder and Undo; Dinner and Party activities with songs and "No
  activities"; dedications open until song and timing, with pending, failed
  and stale saves. Staff edit on a phone, hide and restore the program,
  archived read-only; contract, payments and booking stay unchanged.
- `tests/unit/planning-contacts.test.ts`: phone and email checks, the
  day-of source's fields, vendor checks, preferences and music styles.
- `tests/e2e/contacts-flow.spec.ts`: on a phone, the MC and officiant shown,
  not re-entered. A day-of contact by reference with a phone for the day (the
  client record unchanged), then someone else. Vendors with checked phone and
  email, edit, reorder, undo and reload. A contact leaving the event. The
  announcement language read from Event basics. Music styles with pending,
  failed and stale saves. Staff edit on a phone; hiding keeps answers;
  contract, payments and booking stay unchanged.
- `tests/e2e/people-flow.spec.ts`: on a phone, Processional people with
  pronunciation and links to its own songs (linked songs can't be removed,
  renames show through the link, reordering, reload); the couple's entry
  using the Couple entrance song, which then can't be removed there. Introductions sharing
  Entrance music songs, a stale tab's refused removal and Undo, a hidden
  Entrance music. The MC, and speeches with an exact time, next day, a cue
  and undecided timing, with pending, failed and stale saves and Undo. Staff
  edit on a phone; contract, payments and booking stay unchanged.
- `tests/e2e/music-flow.spec.ts`: on a phone, the client adds, edits,
  reorders and removes songs (with undo) and reloads. It pastes a list,
  corrects flagged lines and imports once. It sees duplicate and
  do-not-play warnings, chooses DJ's choice, not applicable and discuss with
  truthful progress, and enters cue songs with instructions. Saves pending,
  failing and from a stale tab are covered. Staff edit the same songs, hide
  and restore a list with its songs, and see archived plans read-only;
  another business gets a 404. Contract, payments and booking stay
  unchanged.
- `supabase/tests/database/31_planning_cutoff.test.sql` covers the deadline
  and reopening rules (see the table above).
- `tests/unit/planning-cutoff.test.ts`: deadline display in the event's zone
  across DST, datetime-local values, reopening input, reasons, the locked save
  result and client-safe parsing.
- `tests/integration/planning-cutoff.test.ts`: a client save that waits on a
  row lock (held by another session) across the deadline is refused, and one
  whose wait ends before it saves; every write path refused after the
  deadline with client-safe fields, staff still saving, direct REST writes
  refused; reopening expiring by database time; saves racing "close now"
  (all or nothing); two staff changing the deadline or reopening at once (one
  wins, one conflict, one audit), double clicks; archiving racing reopening
  and saving; anon. Deadlines are placed seconds away with trusted SQL
  (`tests/integration/support/sql.ts`), never waited for.
- `tests/e2e/cutoff-flow.spec.ts`: on phones, the owner setting (existing
  plan unchanged), the client's deadline in the event's zone, a tab left open
  across the deadline (locked, typed value kept, all editors read-only),
  staff editing after it, reopening with a reason and expiry, the client
  editing until the shown end, closing early refusing a stale tab, a moved
  event date and explicit recalculation, no reasons or staff emails for the
  client, contract, payments and booking unchanged.
- `tests/unit/run-sheet.test.ts`: the projection on a detailed French
  wedding, a Simple Party and an incomplete plan (stage order, hidden items,
  reuse, shared songs shown once, cues, overnight times, explicit choices,
  conflicts, open answers, no staff-only data), then real PDFs: extracted text
  checked for sections, pronunciation beside names, repeated column headers
  only on overview pages, and no `undefined`, `null`, ids or contract wording.
  Pages are written to `review-samples/run-sheet/` for review.
- `tests/integration/run-sheet.test.ts`: linked songs resolved through the
  real staff session; two readers during 15 rounds of concurrent relinking
  never see a broken link; a staff change after the client deadline appears
  with a new revision; clients, other businesses and anon get nothing;
  archived events stay readable for staff.
- `tests/integration/version-conflicts.test.ts`: stale versions through
  the real PostgREST HTTP API (booking policy, taxes, planning deadline days,
  plan and template structure, contract template draft) answer 409 `PT409`
  within 2 seconds, write nothing and cause no retry loop. Set
  `FLUX_REST_V14_URL` to a second PostgREST on the same database to check
  another version too.
- `supabase/tests/database/36_staff_dashboard.test.sql`: who may read the
  dashboard (anon, other businesses, clients, suspended workspaces), each
  event's own date (Kiritimati and Pago Pago), archived and past events,
  ordering and the limit, submitted versus approved proposals, deposits under
  the deposit policy (partial, received), 0% deposits and the signature
  policy, legacy contracts before and after their check, planning closing,
  later, closed, reopened, expired reopenings, past, archived, unbooked and
  complete plans, email failures versus retries, other businesses and
  platform emails, setup facts, and that reading changes nothing.
- `tests/e2e/dashboard-flow.spec.ts`: a new workspace (checklist, owner and
  staff wording, empty states, quick actions) and a busy business (order,
  a real submitted proposal, planning, a deposit, an email failure, the
  attention cap and "Show all", every link) on desktop and a phone.
- `supabase/tests/database/37_staff_lists_client_archiving.test.sql` and
  `tests/e2e/list-pages-flow.spec.ts`: who may list and archive, each
  event's own date, ordering, status, search (literal % and _), archived
  inclusion and counts, pages, client archive and restore (no restamp,
  audited, links kept), empty states, URL state across Back, the dashboard's
  Add client link, another business refused, and phone layouts.
- `tests/e2e/event-workspace-flow.spec.ts`: twelve real event states (new,
  draft, sent, submitted, approved, regenerated contract draft, sent, signed
  awaiting the deposit, booked, legacy, deposit corrected after booking,
  archived): the next step and its links, summaries from the payment
  summary, history, deep links opening sections, unsaved edits and errors
  kept visible, the legacy booking check, and phone layouts at 390 and 320 px.
- `tests/e2e/navigation-shell-flow.spec.ts`: the staff and platform shell:
  every sidebar link and the active item on detail pages, owner, staff and
  platform-administrator menus, two businesses with wide and light logos and
  one without (centred, never stretched), the account menu and business
  switch, sign-out, the phone drawer's focus trap, Escape and scroll lock,
  320 px, landscape and installed-app layouts. `E2E_SCREENSHOTS=1` also keeps
  review screenshots.
- `tests/e2e/pwa-flow.spec.ts` (browser emulation, not a real iPhone): the
  manifest and icons (fields, sizes, types, nothing personal) and Chromium's
  installability check with no service worker; `/start` for signed-out,
  staff, client, both-role and several-business users; install help with the
  native prompt, iPhone Safari, Chrome on iPhone, Android without a prompt,
  dismissal and standalone; in standalone, the run sheet PDF through the
  share sheet with the app's session, an honest error and notice offline,
  ways out of every page, and no service worker, caches or private storage;
  the client's planning and contract pages standalone on a phone.
- `tests/e2e/run-sheet-flow.spec.ts`: on a phone, from the event page to the
  read-only run sheet (no inputs, collapsed lists, Do not play one tap away,
  no sideways scrolling); the PDF downloaded through the app (same revision,
  private no-store headers, content and exclusions, pages rendered to
  `review-samples/run-sheet/app-download/`); a change after the
  deadline on refresh and in a new export; signed-out, client and other
  business refused; nothing contractual changed.
- `tests/integration/planning.test.ts`: concurrent payments and checks create
  one plan; repeated checks and setup never replace it; concurrent setup and
  starter installs; concurrent client saves (one wins, the rest conflict);
  frozen wording after catalog changes; REST isolation for clients and other
  businesses; a client of two DJs.
- `tests/e2e/planning-flow.spec.ts`: the Basics-only fallback and staff
  prompt; starter templates, renaming, reordering, removing, a stale tab and
  duplicating; the client on a phone (imported answers, autosave, edits during
  a pending save, failed save and retry, stale tab); applying a template
  without losing answers; stage details on a phone (venue reuse, discuss with
  DJ, completion, reload, overnight times, timing warnings, edits during a
  pending save, failed save, stale tab); staff edits reusing Event basics;
  hiding and restoring stages with their answers; contract, payments and
  booking unchanged; template edits not reaching the plan; archiving and
  unarchiving.

### Booking tests

- `supabase/tests/database/24_booking.test.sql` covers the rules (see the
  table above).
- `tests/integration/booking.test.ts`: a deposit paid before signing books
  the event when the client signs (real signing code); five concurrent
  payments and three concurrent checks give one booking, one audit event and
  one email; the booking email goes through the real Resend adapter (HTTP
  answered locally) and its retry after a business rename is byte for byte
  the same; a worker from before booking emails doesn't claim it.
- `tests/e2e/payments-flow.spec.ts` continues: the client signs, the event
  awaits the deposit, recording the rest books it and the confirmation email
  arrives in Mailpit, and invalidating that payment keeps the booking with a
  warning while the client sees what is outstanding.

### Payment tests

- `supabase/tests/database/23_manual_payments.test.sql` covers the rules and
  totals (see the table above).
- `tests/integration/payments.test.ts` sends truly concurrent requests
  through the API: six identical submissions record one payment, and two
  different submissions with the same amount and date record one while the
  other asks for confirmation. Clients and other tenants can't record,
  invalidate, write, read or set the invoice link.
- `tests/e2e/payments-flow.spec.ts` records payments on the event page
  (double click, duplicate confirmation, invalidation with a reason), saves an
  invoice link (http refused), shows sent-contract terms, and checks the
  client's phone-width summary has no references, notes or reasons.

### Integration tests

`tests/integration/proposal-flow.test.ts` covers the outbox:
- A failed email is retried with backoff using the identical link, with no
  new links or records.
- Emails exhaust their attempts, then staff retry them.
- Emails for superseded offers are cancelled.
- Links that no longer match the secret are refused.
- The whole flow delivers to Mailpit.

It also covers concurrent submissions, where exactly one wins, and checks
that the client view and links leak nothing and grant no event access.
`tests/integration/support/fixtures.ts` holds the shared setup.


Integration tests run with Vitest against the local stack and refuse any
non-local URL.

`tests/integration/offers-pricing.test.ts` runs the whole step 4 flow:

1. A staff user with a real magic-link session freezes an offer from a
   template.
2. The snapshot is read back through RLS and validated by the TypeScript
   schema.
3. The spec example is priced and committed, so the database's deferred
   verification runs for real.
4. It checks that stale versions, invalid input and a writer that lowers a
   price are all rejected.
5. It changes the catalog and confirms the frozen offer is unchanged.

Proposals can't be deleted, so this test leaves its uniquely named tenant
behind, archived. `pnpm db:reset` clears it.

`tests/integration/storage-gear-media.test.ts` runs through the real Storage
HTTP API. It creates throwaway users and gets real sessions through the
magic-link token flow, so there are no passwords and no hand-made JWTs. It
checks uploads, downloads, signed URLs, cross-tenant access, overwrites,
deletes, MIME types, clients and anonymous users, then removes everything it
created. It refuses to run unless the Supabase URL is local.

## How tenant isolation works

Isolation is enforced by the database, not by application code.

1. **Composite foreign keys.** Every tenant-owned table carries `tenant_id`
   and exposes `unique (tenant_id, id)`. Children reference parents with
   `(tenant_id, parent_id)`, so a row can never point at another tenant's
   row.
2. **Immutable keys.** Triggers reject changes to `id`, `tenant_id` and
   parent references for every role, including the service role.
3. **RLS and column grants.** Policies limit rows to the caller's tenants.
   Column-level grants limit which fields staff can write. For example,
   `events.lifecycle_status` changes only through future transactional server
   operations.
4. **Deny by default.** A migration revokes default privileges for `anon`
   and `authenticated`. Every new table needs explicit grants, RLS and tests.

### Staff authentication

- **Magic links only.** Login uses magic links and no passwords. Public
  sign-ups are disabled in `supabase/config.toml`, so the admin API creates
  every user. The login form never creates accounts and always shows the
  same message.
- **Scanner-safe links.** The email template points at `/auth/confirm`,
  which needs a click on **Sign in** (a POST) before it verifies the token.
  A link scanner that prefetches the URL therefore can't use it up.
- **Server checks.** `src/proxy.ts` refreshes the session and sends
  signed-out visitors to `/login`. That is a convenience only. Every staff
  page and action calls `requireStaff(slug)`, which checks the user with the
  auth server and the membership through RLS.
- **Hosted projects** need the same email template, redirect URLs and
  sign-up setting configured separately.

### Gear uploads

Files go straight from the browser to Storage, because Server Actions are
capped at 1 MB and hosting platforms limit request bodies.

1. A server action checks the declared type and size, then picks a random
   object path.
2. The browser uploads the file with the staff session. Storage RLS allows
   only the staff member's own tenant and gear item.
3. A second server action reads the object's first 4 KB through a
   short-lived signed URL and checks the real file signature. Accepted
   formats are JPEG, PNG, WebP, AVIF, MP4 and WebM. The signature must match
   the declared type and the size must be within limits.
4. Only then is a `gear_media` row created. Anything else is deleted with
   the service role. Offers only reference registered media, so they never
   include an unchecked file.

### Offers, snapshots and pricing

- **Drafting.** Each event has one editable draft, `proposals.draft_offer`,
  saved in place with an optimistic `draft_version`. Staff use
  `open_proposal_draft`, `update_proposal_draft` and
  `proposal_offer_input_from_template`. Editing never freezes anything or
  creates revisions.
- **Previewing.** `preview_proposal_offer` builds the snapshot in memory,
  using exactly the validation and builder that freezing uses. It stores
  nothing.
- **Freezing an offer.** Only `send_proposal` freezes a snapshot, inside the
  send transaction, and it does so exactly once. Under a row lock it
  enforces the offer rules and copies everything into
  `proposals.offer_snapshot`:
  - packages, included quantities, gear prices and descriptions, and active
    media references
  - addons, questions and active rules of offered questions
  - tax rates and categories, currency, branding and expiry
  - the database computes `offer_sha256` itself
  - the snapshot and hash can never change afterwards
- **Pricing.** `src/lib/pricing` is pure, deterministic TypeScript, shared by
  the server and a future browser preview. It follows spec section 5:
  - input is only a package key, addon quantities and answers, and unknown
    fields such as prices are rejected
  - required gear is aggregated across rules, then reduced by package
    inclusions
  - gear that is both required and optional is charged
    `max(optional, required extra)`, so it is never charged twice
- **Tax policy.** For each line and each tax code in that line's category,
  `round_half_up(line_total × rate_ppm / 1,000,000)`, summed per code. Every
  configured rate is listed, including zero amounts.
- **Tax categories.** `tenants.tax_categories` maps a category key to tax
  codes. There is no implicit default, and an unmapped category blocks offer
  creation.
- **Tax settings.** Owners edit taxes and category mappings in Settings,
  under Taxes; other staff see them read-only. Rates are typed as percentages
  with up to 4 decimals and converted exactly to `rate_ppm` (no floats).
  `update_tax_settings` is the only write path. It checks the owner role and
  `tax_settings_version` (stale tabs get a conflict), refuses a tax still
  used by a category and unmapping a category used by active gear or
  packages, and audits each change. Each category is not configured, no tax
  (`[]`), or a set of taxes. Only new offers read these settings.
- **Selections.** A proposal's single editable client selection lives in
  `proposal_selection_drafts` and is autosaved with optimistic versions.
  Immutable `proposal_selections` rows are submissions only.
- **Verification.** The database re-checks every submission against the
  frozen offer, not just the money. It checks unit prices, line totals,
  subtotal, per-line tax rounding and total. It also checks the package,
  addon keys and bounds, required and typed answers, and that the
  chargeable and included lines match the rules, the package inclusions and
  the addons.

### Sending, client access and approval

- **Sending.** `send_proposal` runs as the staff user, with membership
  checked inside, in one transaction:
  - it checks the editor's draft version (unsaved edits elsewhere cause a
    conflict) and freezes the offer
  - it sets the deadline
  - it supersedes and revokes the previous offer, whose terms stay untouched
  - it points `events.active_proposal_id` at the new offer, and a partial
    unique index allows only one actionable proposal per event
  - it creates the access link for the primary contact and queues the email
  - it leaves the event as a lead, because sending is not a booking
- **Link tokens.** The server picks the link id and derives the token as
  `base64url(HMAC-SHA256(PROPOSAL_LINK_SECRET, "flux:proposal-link:v1:" + id))`,
  which is 256 bits. The database stores only `sha256(token)`, in
  `access_links.token_hash`, which staff can't even read. The outbox stores
  only the link id. An email retry re-derives the identical token, so no
  plaintext or encrypted token is ever stored and retries never create new
  links. Before sending, the worker compares the hash, so a rotated secret
  makes undelivered proposal emails fail visibly instead of sending a dead
  link.
- **Opening a link.** Emailed links put the token in the URL fragment
  (`/bouprod/p#token`). Browsers never send fragments, so the token can't
  reach request logs or analytics, and scanners that don't run JavaScript
  can't open sessions.
  - The page removes the token from the address bar at once and POSTs it to
    `/{tenant}/p/exchange`.
  - That route accepts same-origin JSON only and is rate limited per hashed
    IP in Postgres.
  - It creates a 12-hour proposal session: a random token in an HttpOnly,
    SameSite=Lax cookie scoped to `/{tenant}/proposals/{id}`, stored only as
    a hash. It then redirects to the clean URL.
  - GET requests never change anything.
- **Every client read and write** goes through service-role database
  functions: `client_proposal_view`, `client_save_selection_draft` and
  `client_submit_selection`.
  - Each call re-resolves the session and rechecks tenant, proposal,
    revocation, link and session expiry, offer deadline, active proposal
    and state.
  - Responses are explicit safe objects. They never include internal notes,
    other contacts, draft input or staff fields.
  - Media gets 10-minute signed URLs, only for paths inside the frozen
    offer.
  - Anonymous users still have no table or Storage grants.
- **Submission** is one transaction:
  - it locks the event, then the proposal
  - an idempotency key makes repeat clicks return the original submission
  - the draft version must be current, so a stale tab can't submit
  - the database verifies prices and choices, records the submission, sets
    the event to pending approval, and notifies staff
  - submitting never grants event access, signing or planning
- **Approval.** `approve_proposal_selection` approves the exact latest
  submission. The approval records the selection's SHA-256, and repeats
  return the same approval. It moves the event to awaiting signature, not
  booked, and the client is told the contract will follow. To change terms,
  start a revised offer: it opens a draft prefilled from the current offer,
  and the client reviews and submits again.
- **Email outbox.** Business state commits first, then a row is queued with
  a unique dedup key.
  - Delivery runs right after each action, through Next.js `after()`, and
    from `pnpm outbox:work`, which calls `POST /api/internal/outbox` with
    `OUTBOX_WORKER_SECRET`. A hosted cron job can call the same endpoint.
  - Claims use `FOR UPDATE SKIP LOCKED` with expiring locks, and retries
    back off from 1 minute up to 1 hour.
  - After the last attempt an email is marked failed and shown to staff
    with **Retry**. Proposal emails for superseded offers are cancelled.
  - Delivery is at least once: a crash after sending but before recording
    can resend one email. Retries never create proposals, submissions,
    approvals or links.
- **Email transports** are `src/lib/email/transport.server.ts`: Mailpit's
  HTTP API locally, and Resend behind the same server-only interface for
  hosting. `EMAIL_TRANSPORT=resend` with `RESEND_API_KEY`. Resend isn't used
  locally or in tests.

### Contract sending and verified client access

Clients can read a sent contract. They cannot sign it yet.

- **Send.** **Send contract…** on the review screen runs `send_contract` in
  one transaction:
  - it locks the event, then the proposal, then the contract
  - it re-runs `private.contract_send_problems`
  - it marks the contract sent, with `sent_at` stamped once by the database
  - it creates an invitation (`access_links` with purpose `contract`) that
    expires after 14 days and is scoped to the tenant, event, contract and
    frozen signer
  - it queues the contract email with the dedup key `contract_sent:{link}`
    and writes an audit record

  Repeated or concurrent sends return the existing result. Content and
  hashes never change, and the event stays awaiting signature. Only this
  function can move a contract to `sent`; the transition trigger requires a
  marker that only it sets.
- **Invitation token.** It is `HMAC(PROPOSAL_LINK_SECRET,
  "flux:contract-invite:v1:" + link id)`. Only its SHA-256 is stored, and the
  worker re-derives it at delivery, as proposal links do. The email link is
  `/{tenant}/invite#token`: the token stays in the fragment, out of server
  logs, and is removed from the address bar. The token is not proof of
  identity. Its only power is asking for a verification email to the frozen
  signer address, rate-limited per IP and per invitation, three every 15
  minutes. That first step needs JavaScript.
- **Verification email.** The `contract_sign_in` outbox email gets its
  Supabase link from the worker at delivery time, through the Auth admin
  API:
  - `invite` when the address has no verified identity. Trusted code creates
    the identity, and public signup stays disabled.
  - `magiclink` when a verified identity exists, for example a client of
    another DJ or a staff user.

  The link goes to `/auth/confirm` with `type` and `next`. Both are
  allow-listed, and `next` may only be an invitation, contract, `/my` or
  `/staff` path. Verification needs the explicit **Sign in** POST, which
  works without JavaScript and sends a real Origin (`strict-origin`). It
  works in any browser or device.
- **Acceptance.** `/{tenant}/invitations/{id}` shows a page, and only its
  **Open my contract** POST runs `accept_contract_invitation`. That
  function:
  - locks the event and rechecks the invitation, contract and event
  - requires the session's verified email to equal the frozen signer email
  - grants `event_access` idempotently, to the exact tenant, event and
    signer client

  A wrong account is shown only that the invitation belongs to a masked
  other address. No client data is accepted from the browser.
- **Reading.** `/{tenant}/contracts/{id}` calls `client_contract_view`, a
  safe DTO of frozen data. It rechecks on every read:
  - the verified identity
  - active event access for the signer client
  - the signer email
  - that the contract is sent, its approval current, and the event and
    tenant not archived

  `/my` lists readable contracts. Returning clients sign in at `/login`
  with the same magic-link form and land on `/my`. Signing in never grants
  planning access or confirms a booking.
- **Resend** (`resend_contract`). It revokes earlier invitations, cancels
  their pending emails, issues a fresh invitation and email, and is audited.
  `sent_at`, content, hashes and granted access are kept. It is limited to
  once every 2 minutes and 10 times a day.
- **Void** (`void_contract`, with a reason). It works on sent, unsigned
  contracts only. Invitations are revoked and pending contract emails
  cancelled. Clients can no longer read the contract, while event access,
  other events and identities are untouched. A replacement can then be
  generated; generation is refused while a contract is sent.
- **Revised offers and archiving.** A revised offer voids the sent contract
  automatically. Archiving revokes invitations and cancels contract emails,
  and unarchiving revives neither.
- **Withdrawn notice** (`contract_voided`). Every void of a sent contract,
  whether by staff or by a revised offer, queues one email to the frozen
  signer in the same transaction, deduplicated per contract. It says the
  contract is no longer available and the DJ will follow up. It carries no
  link and no internal reason, and doesn't suggest the event is cancelled.
  Archiving never queues or cancels it.
- **One sign-in per browser.** Supabase keeps a single session cookie, so
  opening a client sign-in link in a browser where staff are signed in
  replaces the staff session. Staff pages and actions then redirect to
  `/login?notice=no-staff-access`, which names the signed-in account and
  explains this, instead of a bare 404. Nothing is changed. The redirect
  happens only when the account has no staff role anywhere, so it reveals
  nothing about tenants; staff of another tenant still get 404. For manual
  testing, open client links in a private window or another browser.

**Ordering and recovery.** Postgres commits business state first: the
contract, invitation, queued email and audit record. Email delivery and
Supabase Auth calls happen afterwards in the worker, through `after()` or
`pnpm outbox:work`, and are never inside a transaction.
- **Dispatch rechecks.** Before sending, the worker rechecks that the
  contract is still sent and current, the invitation unrevoked and
  unexpired, and the event unarchived. Otherwise it cancels the email.
- **Fresh links on every attempt.** Each `contract_sign_in` attempt creates
  a new Supabase link, which invalidates the previous one. A crash after
  sending but before recording can therefore resend one email, and only the
  newest link works. Supabase verification links expire after one hour, and
  invitations after 14 days.
- **No tokens stored.** Neither the invitation token nor any Supabase token
  is written to the outbox, logs or error text.
- **Access is never premature.** It is granted only by the verified POST.
- **Recovering a stuck invitation.** If a verification email is lost or
  expires, the client asks for another from the invitation page. If the
  invitation is lost or expires, staff resend. Failed emails appear under
  **Emails** with **Retry**.

No new environment variables are needed. Invitations reuse
`PROPOSAL_LINK_SECRET` with their own domain prefix, and rotating it fails
undelivered contract emails visibly.

### Business settings and contract send review

- **Owner-only settings.** The owner manages `/staff/{tenant}/settings`:
  - legal business name (`tenants.business_name`)
  - business address
  - contact email
  - deposit percentage, a whole number from 0 to 100, default 50

  The display name stays the client-facing brand. Changes go only through
  `update_business_settings`, which checks the owner role in the database.
  Staff can see the values but not edit them.
- **New placeholders.** `{{business.legal_name}}`, `{{business.address}}`
  and `{{business.email}}`. `{{business.name}}` is kept for existing
  templates and means the legal name.
- **Deposit.** It is `round_half_up(total × percent / 100)` in integer cents,
  and the balance is the total minus the deposit. Each new contract freezes
  the percentage (`contracts.deposit_percent` and the commercial snapshot),
  the amounts and the business identity.
- **Existing contracts.** They were backfilled at 50%, which their snapshots
  record. No snapshot or hash was rewritten.
- **Regeneration.** Changing settings never alters a draft. Regenerate it
  explicitly to pick up new values.
- **Version choice.** Generation defaults to the latest published template
  version, which is labelled, and staff can choose another. The balance due
  date is still entered per contract.
- **Review and send.** **Review and send…** on a contract draft runs
  `review_contract_for_send`, read-only. It shows:
  - the intended signer and recipient email
  - the frozen business identity
  - the exact contract text
  - the deposit, balance and deadline
  - every problem found by `private.contract_send_problems`: archived event,
    not the current draft, superseded approval, changed or missing signer,
    incomplete settings, or business details or deposit changed since
    generation
- **Sending.** **Send contract…** sends from the review screen once every
  check passes. See "Contract sending and verified client access".

### Contract signing

- **Who signs.** Only the contract's frozen signer, signed in with a current,
  verified Supabase session whose email matches the frozen signer email, and
  holding event access for that signer. The server reads the identity from
  `auth.getUser()`, which checks the session with the Auth server. An
  invitation token is never signer identity. There is no second email check
  per signature.
- **What the client provides.** A typed name, a drawn signature
  (`signature_pad`, exported as a 900 × 300 PNG), the consent checkbox and the
  content hash of the contract they were shown. The server and database derive
  the signer email, user id, time, consent text and request context.
- **Signing modes.** Every published template version has an explicit
  `usage`, chosen when publishing and immutable like the text:
  - `demo`: test wording. Contracts, the signing page and signed PDFs are
    labelled "DEMO, NOT FOR CLIENT USE", and the client accepts the `demo-v1`
    consent. Any staff member may publish DEMO versions.
  - `client_use`: the business's own agreement. Only the owner can publish
    it, after checking the responsibility statement (`client-use-v1`: the
    owner is responsible for the agreement and approves it for clients;
    Flux DJ has not reviewed or approved it and gives no legal advice). The
    exact statement, the owner's user id and the database time are stored on
    the version. The client accepts the `client-v1` consent. No DEMO labels.
  - The previous two-argument `publish_contract_template_version(id, draft
    version)` remains for older callers: it publishes DEMO-titled versions as
    DEMO, replays versions already published, and refuses everything else, so
    nothing is ever approved for client use without the owner's confirmation.
  - `legacy`: versions published before modes existed that were not DEMO.
    Contracts can't be generated from them; open a new draft version (the
    text is copied) and publish it for client use.

  A contract freezes `signing_mode` and `consent_version` from its template
  version when it is generated (`contracts_signing_terms`); nobody can choose
  or change them. The client view shows that exact consent, unchecked, and
  `sign_contract` accepts only that version and stores its text in the
  evidence. Changing wording or usage always needs a new version, and
  publishing sends or signs nothing.
- **Existing contracts.** The migration classified existing data with the old
  title rule ("DEMO, NOT FOR CLIENT USE"): DEMO versions and contracts stay
  DEMO with `demo-v1`, and signatures, evidence, hashes and PDFs are
  unchanged. Other contracts get `signing_mode = none`: they can't be signed
  or sent (review lists the problem), and the contract page explains how to
  publish a client-use version and regenerate (or void and replace a sent
  one). Nothing old becomes signable automatically.
- **Image checks (server).** Only a base64 PNG data URL of at most 256 KiB.
  The server accepts plain 8-bit, non-interlaced PNG only, with CRCs checked,
  no unknown critical chunks or trailing bytes, an exact inflate cap,
  dimensions within 300–1800 × 100–600, and enough dark ink over a minimum
  span. It then re-encodes the pixels into a fresh PNG, so nothing else from
  the upload is stored.
- **Ordering and retries.** Storage and the database can't share a
  transaction, so the order is:
  1. Validate the request and image, and run the read-only eligibility check
     as the user.
  2. Upload with the service role to the private `contract-signatures` bucket
     at a new `{tenant}/{contract}/{uuid}.png`, never overwriting.
  3. Call `sign_contract` (service role only). One transaction locks event,
     proposal and contract, rechecks everything, and confirms the object
     exists with the declared size and type and is unused. It then inserts
     the immutable `contract_signatures` row, moves the contract
     `sent → signed`, retires invitations and writes one audit event.
  - **Rejection or replay:** the database's answer is definitive, so the
    upload is deleted.
  - **Unknown outcome** (lost response): the upload is kept, because a
    committed signature may reference it. A retry returns the existing
    signature as a replay, to the same signer only.
  - **Concurrent attempts** wait on the event lock. Exactly one commits.
  - **Crash** between upload and commit: an orphan stays behind. Nobody but
    the service role can read it, and `private.contract_signature_orphans`
    lists it for manual cleanup. No automatic cleanup exists yet.
  - A deferred check guarantees that a signed contract always has exactly one
    evidence row.
- **Evidence.** Typed name, verified email and user id, image path, SHA-256,
  size and dimensions, database signing time, frozen content hash, exact
  consent text and version, and user agent. The IP is recorded only on Vercel,
  from `x-vercel-forwarded-for` (set by Vercel, not spoofable). Anywhere else
  it is stored as unavailable. Evidence rows can't be updated or deleted, and
  evidence stays out of the audit log and app logs.
- **Viewing.** Staff of the tenant read evidence through row-level security,
  and get two-minute signed URLs for committed signatures only, through a
  Storage policy. The signer sees the signed name and time and a two-minute
  link issued by the server after `client_signature_object` authorizes it.
  Clients and anon have no Storage policy and can't read or list the bucket.
  Nobody but the service role writes to it.
- **Protected paths.** Nothing leaves `signed`. Void, resend, regeneration
  and replacement refuse signed contracts. A signed contract blocks
  commercial revisions: `open_proposal_draft` refuses, and a trigger refuses
  superseding the signed proposal, so `send_proposal` rolls back. Archiving
  hides the event and cuts client access but keeps the agreement and
  evidence; unarchiving restores the signer's read access.
- **Booking.** Signing confirms the booking only as the contract's frozen
  booking policy allows (see "Booking confirmation"). It grants no planning
  access and records no payment. The client sees "Contract signed.", the
  booking state, and "Your DJ will follow up with the next steps."
- **Retention is undecided.** Nothing deletes signatures or evidence, and no
  retention period is set. Decide one (and how to handle archived tenants and
  deletion requests) before real clients sign. Collecting this evidence does
  not by itself establish legal compliance for electronic signatures; that
  needs review of the agreement, the consent wording and the process.

### Signed PDFs and signed copies

- **What the PDF shows.** It is rendered with `@react-pdf/renderer` only from
  the frozen contract (text, parties, terms, content hash) and the signing
  evidence. It includes:
  - the full agreement, with numbered pages
  - the frozen business and client identities
  - the agreed price, taxes, deposit and balance
  - the typed name, the signature image, and the signing time in the event's
    time zone and in UTC
  - the contract id and the contract content SHA-256
  - the consent text and version
  - the recorded IP (or "Not recorded") and the user agent

  DEMO contracts carry DEMO labels on every page; client-use contracts have
  none (decided by the frozen `signing_mode`, never the wording). Both state
  that the PDF records the client's signature only, with no signature from
  the business. Fonts are bundled in
  `assets/fonts/dejavu` (Latin and French accents, no network fetch) and
  traced into the deployed functions by `next.config.ts`.
- **Two different hashes.** `contracts.content_sha256` identifies the agreed
  text, terms and parties. `contract_documents.pdf_sha256` is the SHA-256 of
  the exact final PDF file. The PDF never contains its own hash.
- **Durable job.** `sign_contract` queues one `document_jobs` row in the
  signing transaction. Rendering happens later, so a failure never touches
  the signature. The worker (`src/lib/contracts/documents.server.ts`) runs
  right after signing and after **Generate signed PDF**, for that contract's
  job only (the contract id comes from the database's answer, never the
  browser), so other tenants' backlog never delays it. The scheduled
  `/api/internal/outbox` route drains everything else, including anything
  the immediate run failed or never finished:
  1. Claim with a 2-minute lease.
  2. Verify the signature image against its recorded hash. A mismatch fails
     the job permanently and visibly.
  3. Render, then hash the final bytes.
  4. Upload to a new `{tenant}/{contract}/{uuid}.pdf` in the private
     `contract-documents` bucket.
  5. `commit_contract_document`: atomically records the one canonical
     document, marks the job succeeded and queues the signed-copy emails.

  Retries back off (1, 2, 4… minutes) for up to 5 attempts, after which staff
  see the error and can retry.
- **Concurrency and recovery.**
  - **Second commit:** a second commit for the same contract (a stale or
    parallel worker) returns `exists`. That worker deletes its upload, and the
    canonical PDF is reused forever; nothing overwrites it.
  - **Crashed worker:** its lease expires and another worker retries.
  - **Lost commit response:** the upload is kept, because it may be canonical.
  - **Orphans:** unreferenced uploads appear in
    `private.contract_document_orphans` and are readable only by the service
    role. No automatic cleanup exists yet.
- **Downloads.** `/{tenant}/contracts/{id}/signed-pdf` (signer) and
  `/staff/{tenant}/contracts/{id}/signed-pdf` (staff) recheck access on every
  request. They then stream the bytes after checking them against
  `pdf_sha256`, with `Content-Disposition: attachment` and
  `Cache-Control: private, no-store`. A mismatch returns an error and never
  the file. The bucket has no Storage policies and there are no signed URLs.
  Archiving blocks the signer's download but keeps the PDF; staff can still
  download it.
- **Emails.** A commit queues `contract_signed_copy` for the frozen signer
  email and the frozen business contact email. Each recipient gets its own
  row, dedup key and status, so a retry for one never resends the other. The
  worker attaches the committed PDF after the same hash check; a mismatch
  fails permanently. No bytes, paths, URLs or tokens are stored in the
  outbox. Resend receives `Idempotency-Key: flux-signed-copy-{row id}`, which
  closes the crash-after-send window for 24 hours. After that, or with
  Mailpit, a crash between sending and recording can resend one copy. Mailpit
  (local) and Resend (hosted) both send real attachments.
- **Frozen sender.** Resend refuses a reused key with a different request, so
  every attempt must be identical. Each row's `sender` freezes the business
  display name (also used in the text), the from name and the reply-to when
  queued, and the from address (`EMAIL_FROM_ADDRESS`) at the first attempt
  (`freeze_email_sender`). Keys are set once and never change. Retries are
  built only from the payload, the frozen sender and the canonical PDF, so
  changing Business settings between attempts changes nothing. Rows queued
  before this existed freeze the then-current settings at their next attempt;
  if such a row had already reached Resend and the settings changed since,
  that one retry can still get a 409 within the 24 hours. Sent rows are never
  changed.
- **Contracts signed before PDFs.** They have no job. Staff click **Generate
  signed PDF**, which sends no email. **Send signed copies…** is a separate
  step whose confirmation lists both recipients; the database checks that
  they match the frozen addresses.

### Manual payments

- **What it is.** Staff record payments received elsewhere (Wave, e-transfer,
  cash). Flux DJ never processes, verifies or invoices anything. Recording or
  invalidating a payment never changes a contract or planning access. It may
  confirm a booking under the signed contract's policy (see "Booking
  confirmation"), which is the only email it can cause; it never undoes one.
- **Records.** `event_payments`: amount in integer cents (positive, parsed
  without floating point), currency, date received (not in the future, in
  the business time zone), optional reference and internal note, and the
  recording staff member (user id, membership, email) and database time.
  Rows are never updated or deleted. `invalidate_event_payment` marks a wrong
  entry once with a required reason, who and when; a correction is a new
  entry. Only `record_event_payment` and `invalidate_event_payment` write,
  for staff of the event's business; clients and other tenants can't read or
  write anything. Recording and invalidating are blocked while the event is
  archived, and are audited.
- **No double recording.** Each form submission carries an idempotency key
  (unique per business): a retried or double-clicked submission returns the
  first result, and a reused key with different values is refused. Another
  valid payment with the same amount and date on the event needs explicit
  confirmation. Payments for one event are serialized by the event lock.
- **Authoritative terms.** Only one contract per event can be sent or signed
  at a time (a new draft is refused while one is). The summary uses the
  signed contract if there is one (its frozen total, deposit, balance and
  due date), otherwise the contract currently sent to the client, labelled
  as not signed (voiding and replacing it changes the terms). Drafts, void,
  replaced and superseded contracts never count, so totals are never added
  across contract versions. Without such a contract, payments are listed but
  no total or deposit is shown. Live catalog, tax and deposit settings are
  never used.
- **Totals.** `private.event_payment_summary` is the only place they are
  computed: received (valid payments in the terms' currency), deposit still
  outstanding and remaining balance (never below zero), and the amount
  received above the total, shown as a credit. A zero-percent deposit shows
  "No deposit required".
- **Invoice link.** `event_billing.invoice_url`, optional, HTTPS with a host
  name and no credentials (checked by the database), versioned so a stale tab
  gets a conflict. It is rendered as a link with
  `rel="noopener noreferrer nofollow"` and its host shown; Flux DJ never
  fetches it.
- **Client view.** `client_payment_summary` returns the figures and the
  invoice link only for a contract the caller can already read (verified
  signer, live access, nothing archived). No references, notes, staff
  identities, invalidations or record ids.

### Booking confirmation

- **Policy.** `tenants.booking_confirmation_policy`: `on_deposit` (signed and
  the required deposit received; the default) or `on_signature` (signed is
  enough; payment may still be due). Only the owner changes it, in Settings,
  through `update_booking_policy` (versioned; the column has no direct write
  grant). Before this, no screen could set it, so every business still had
  the old column default `on_signature`, which nobody chose; the migration
  moved them to `on_deposit`.
- **Frozen per contract.** `contracts.booking_policy` is copied from the
  business when the contract is generated and never changes, so changing the
  setting only affects contracts generated afterwards. It is not part of the
  content hash, so hashes, evidence and PDFs are unchanged.
- **Automatic, once.** `private.evaluate_booking` runs inside the
  transactions that sign a contract and that record or invalidate a payment,
  after locking the event (the lock order everywhere is event, proposal,
  contract). It reads only the database: the event's signed contract and its
  frozen deposit, valid payments in its currency (payments recorded before
  signing count), and whether the event or business is archived. Under the
  lock it moves the event to `awaiting_deposit` (deposit still due) or to
  `booked`, setting `booking_confirmed_at` once, writing one audit event and
  queuing one booking-confirmation email in the same transaction. A 0%
  deposit is satisfied by signing. Repeated or concurrent requests can't
  book twice. A trigger refuses any other way of booking, changing
  `booking_confirmed_at`, or leaving `booked`. Archived events are never
  booked. Rendering and email happen after the transaction, so they can't
  block or undo a booking.
- **Corrections after booking.** Invalidating a payment never cancels a
  booking. `booking_confirmed_at` stays, and the event page warns staff when
  valid payments no longer cover the required deposit. The client sees the
  accurate amount outstanding. Cancellation, refunds and unbooking are not
  built.
- **Contracts generated before policies existed** (`booking_policy` null)
  are never booked automatically, not by the migration and not by payments.
  The event page shows **Check booking** (`check_event_booking`, staff
  only), which evaluates them as `on_deposit`, whatever the business's
  current setting. If the deposit is still due, the event moves to
  `awaiting_deposit` and later payments are then evaluated automatically.
- **States shown.** "awaiting signature", "Signed · awaiting deposit",
  "Booked", and, for an older contract not yet checked, "Contract signed ·
  booking not checked yet". A booking on signature can still have payment
  outstanding; the event page shows what remains.
- **The email.** `booking_confirmed`, one per event (dedup key), to the
  frozen signer email, with the sender frozen like signed copies and a
  Resend idempotency key. It confirms the booking and states the total, what
  was received and what remains (and the deposit, if not yet received) as of
  the booking, and promises no planning access. It is delivered right after
  the transaction by the signing or payment action, or by the scheduled
  worker, and only while the event is booked and not archived. Workers from
  before this change never claim it (`claim_email_outbox` takes
  `p_include_booking`, default false), so an older deployed app can't send it
  as another kind of email.

### Archiving events

- **Archive or unarchive.** Staff do this from the event page, through
  `set_event_archived`, which checks membership. Staff have no direct grant
  on `events.archived_at`.
- **Hidden by default.** Archived events are hidden from the Events list and
  the dashboard. **Include archived** shows them, marked as archived.
- **One transaction.** Archiving locks the event and does the following
  together:
  - revokes all its proposal links and client sessions
  - cancels pending client emails for its proposals
  - writes an audit record
- **Blocked while archived.**
  - Client sessions resolve as invalid, so clients can't view, edit or submit.
  - Proposals can't be sent or approved.
  - Contract drafts can't be generated.
- **Separate from status.** Archiving never changes the lifecycle status.
  Proposals, contracts and audit history are kept.
- **Unarchiving** clears the flag only. Revocations are one-way, so the client
  gets access again only when staff send a revised offer.

### Contract templates and drafts

- **Templates.** `contract_templates` holds a name and an active flag.
  `contract_template_versions` holds numbered versions of the text: a title
  and 1 to 60 plain-text `{heading, body}` sections.
  - A version is an editable draft until published, with optimistic
    `draft_version` checks. At most one draft exists per template.
  - Publishing stamps the time and computes `content_sha256`, the SHA-256 of
    the canonical jsonb text of `{"title", "sections"}`. After that no role
    can change, unpublish or delete the version.
  - "Editing" a published template opens a new draft version copied from the
    latest one.
  - The template does not store a pointer to a current version. Staff choose
    any published version of an active template when generating.
- **Placeholders.** The only dynamic syntax is `{{group.name}}` from the fixed
  registry `private.contract_placeholders()`. The editor shows the same list.
  - Unknown or malformed placeholders are rejected on save and by a CHECK
    constraint. There is no HTML, markup, filter or expression.
  - The staff editor uses one text field in which `## Heading` lines start
    sections.
- **Generation.** `generate_contract_draft` renders the contract inside the
  database, in one transaction under the event lock. It uses only three
  sources:
  - the published template version
  - the approved, immutable selection and its lines, for every commercial
    value
  - the signer, event, venue and business records as they are at that
    moment, copied into `party_snapshot`
- **Substitution** is a single pass, so a client name containing `{{...}}`
  or `<b>` is stored and shown literally. React renders it as text.
- **Missing values.** Every placeholder a template uses must have a
  non-blank value, and the event needs a signer. Otherwise nothing is stored
  and staff get a list of what to complete.
- **Balance due date.** It is entered by staff when the template uses
  `{{payment.balance_due_date}}`, and refused when it doesn't. Nothing is
  assumed.
- **Deposit.** It is 50% of the approved total including taxes, rounded half
  up to the cent (`private.contract_deposit_cents`). The balance is the total
  minus the deposit, and a CHECK constraint enforces that they add up.
- **One draft per event.** An identical request returns the existing draft,
  which covers double clicks and concurrent calls.
  - A different draft needs explicit replacement, which inserts a new row and
    marks the old one `replaced` with `replaces_id` provenance.
  - Generation and replacement are audited.
- **Stale terms.** Generation requires the event's active proposal to be
  approved. When a revised offer is sent, a trigger marks that proposal's
  drafts `superseded` in the same transaction.
- **Freezing.** Every contract row is content-immutable from insert, for
  every role including the service role. That covers rendered content,
  commercial and party snapshots, provenance, signer, amounts and hash. Only
  `status` moves, and this step allows only `draft` to `replaced` or
  `superseded`.
  - The `sent`, `signed` and `void` statuses exist for later steps, but no
    transition reaches them yet.
  - Contracts are never deleted, and published template versions they use
    can't be removed.
- **Content hash.** `contracts.content_sha256` is the SHA-256 (hex) of the
  UTF-8 bytes of the canonical Postgres jsonb text of:

  ```
  {"schema_version": 1,
   "content":    rendered_content,     -- title and sections exactly as shown
   "commercial": commercial_snapshot,  -- lines, taxes, totals, deposit, balance, due date, source approval
   "parties":    party_snapshot,       -- business, signer, event, venue
   "template":   {"version_id", "content_sha256"}}
  ```

  The database computes it on insert. Verify it in SQL with
  `private.contract_content_sha256(rendered_content, commercial_snapshot,
  party_snapshot, template_version_id, template_content_sha256)`. It is
  separate from the future hash of signed PDF bytes.
- **Access.** Staff of the tenant can read templates, versions and contracts.
  All writes go through membership-checked functions, except renaming or
  archiving a template. Clients and anonymous users have no access.

### Gear media in Storage

Gear images and videos live in the private `gear-media` bucket. The object
path is `{tenant_id}/gear-items/{gear_item_id}/{random uuid}.{ext}`.

- Staff can upload only under a gear item that belongs to their own tenant.
  They can read only their own tenant's objects.
- No user can update or delete an object, and upserts fail. A sent offer can
  therefore never lose or silently change its media.
- Clients and anonymous users have no direct access. Proposal pages will
  receive short-lived signed URLs from the server after authorization.
- Allowed types are JPEG, PNG, WebP, AVIF, MP4 and WebM, up to 100 MiB. The
  `gear_media` row must agree on path, kind, MIME type and extension.

### DJ invitations and new workspaces

Migration `20261018000100_platform_invitations.sql`. Business owners join by
invitation only; public signup stays disabled.

**Platform administrators.** `public.platform_admins` lists the users who may
invite DJs. Nothing derives it from a tenant role, an email address or a
slug, and it gives no access to any business's clients, events, emails or
settings (no tenant policy refers to it; an administrator without a staff
role who opens a workspace is treated like any other non-member). It is
granted only by SQL run as the database owner; the app, the API and even the
service role cannot write it. Every invitation function checks it again in
the database, and the `/platform/invitations` page answers 404 to everyone
else.

*One-time grant on hosted (not applied yet).* After the migration is
deployed, in the Supabase dashboard's SQL editor for the production project:

```sql
-- Exactly one verified Auth user must have this email; it is audited.
select private.grant_platform_admin('<your sign-in email>', 'Flux DJ operator');
-- Check:
select a.user_id, u.email, a.granted_at from public.platform_admins a join auth.users u on u.id = a.user_id;
```

Undo with `select private.revoke_platform_admin('<email>');`. Grants and
revocations are recorded in `public.platform_audit_events`.

**Lifecycle.**

1. *Invite* (`create_platform_invitation`). The administrator enters an
   address and reviews the normalized recipient and the expiry before
   sending. The invitation expires after 14 days. One open (unaccepted,
   unrevoked) invitation per address: another attempt points to the existing
   one, expired or not. At most 50 new invitations per administrator per day.
   The token is `HMAC(PROPOSAL_LINK_SECRET, "flux:platform-invite:v1:" +
   link id)`; only its SHA-256 is stored. The email ("platform_invitation",
   from "Flux DJ", no reply-to) is queued in the same transaction and links to
   `/join#token`, with the token in the fragment.
2. *Resend* (`resend_platform_invitation`, also for an expired invitation).
   It issues a new link id and token with a new 14-day expiry, so the
   previous link stops working at once, and cancels queued emails for the
   invitation. Limited to one per 2 minutes and 10 emails a day.
3. *Revoke* (`revoke_platform_invitation`). Only before acceptance; the link
   stops working and queued emails are cancelled. A new invitation to the
   same address is then possible.
4. *Verification request* (`request_platform_sign_in`, service role). `/join`
   reads the token from the fragment, removes it from the address bar and
   sends nothing until **Email me a sign-in link**. The token only queues a
   verification email ("platform_sign_in") to the invited address: limited
   to 10 per IP per 15 minutes (`platform_sign_in`) and 3 per invitation per
   15 minutes. At delivery the worker asks Supabase Auth for a fresh link,
   exactly as for contract verification: `invite` creates the identity when
   none exists, `magiclink` reuses an existing client or staff identity (no
   duplicate identities). The link opens `/auth/confirm` with
   `next=/join/{invitation}`, so verification keeps the explicit **Sign in**
   POST that scanners can't trigger.
5. *Workspace creation* (`accept_platform_invitation`). `/join/{invitation}`
   asks for the business name (2 to 100 characters) and web address. Only
   the **Create my workspace** POST, limited to 20 per IP per 15 minutes
   (`workspace_create`), calls the function, which locks the invitation row
   and rechecks the signed-in user's verified email, expiry, revocation and
   acceptance. It then creates the tenant, the owner membership for the
   signed-in user and the accepted invitation in one transaction, and audits
   the platform and the new business. The browser supplies only the name and
   address, never a user or tenant id. A taken address (including archived
   businesses) or a reserved one (`private.is_claimable_tenant_slug`: every
   top-level route such as `staff`, `login`, `join`, `platform`, `start`)
   changes nothing and leaves the invitation open. Repeated or concurrent
   submissions by the same user return the same workspace; an accepted
   invitation never creates another, and nobody else can use it.
6. The DJ lands on `/staff/{slug}?welcome=1`: a welcome card links to
   Settings, gear, packages and the three template screens.

**Delivery.** Platform emails use `email_outbox` with `tenant_id` null (a
check constraint allows that only for these two types; staff never see them).
`claim_email_outbox` joins tenants, so workers deployed before this migration
never claim them; `claim_platform_email_outbox` rechecks that the invitation
is still open and unexpired and that the row belongs to its current link and
address. The invitation email is rebuilt from the link id on every attempt,
with a provider idempotency key; the verification email gets a new Supabase
link on every attempt. No token is stored in rows, logs or errors. Platform
emails have no staff **Retry**; resend the invitation instead.

**Signed in somewhere else.** A wrong signed-in account sees only the masked
invited address and a **Sign out** button. The verification link signs in
whichever browser opens it, which is usually Safari on a phone: a Home Screen
app keeps its own sign-in, so the welcome card tells the new owner to sign in
there with the emailed code at the app's sign-in page. Nothing about the
invitation is kept in browser storage.

**New workspace defaults.** No clients, events, gear, packages, questions,
proposal, contract or planning templates are created or copied. Values are
the column defaults the other businesses started with: time zone
America/Toronto, currency CAD, 50% deposit, bookings confirmed on signature
and deposit, planning deadline 14 days, no taxes configured, no reply-to
address (staff notifications go to the owner's sign-in email), no logo or
colours.

**Incomplete setup.** `tenants.business_name` (the legal name) is required,
so it starts as the display name, as a placeholder. The business address and
contact email start empty, and `update_business_settings` always saves all
three together, so "address or contact email missing" means the legal
identity was never confirmed. Existing checks keep contracts unsendable in
that state (`business_settings_incomplete`, and `business_identity_missing`
for drafts generated before). The dashboard says setup isn't finished, and
Settings shows the legal-name field empty with a note naming the placeholder.

### Business branding

Migration `20261020000100_business_branding.sql`. Each business owner sets a
logo and a primary colour in **Settings → Branding**; other staff see them
read-only. The active workspace decides what is shown, never the signed-in
user: someone in two businesses sees each one's own branding.

**Sources of truth.** The existing columns, now written only through
`update_tenant_branding` (owner only, checked in the database, versioned by
`tenants.branding_version`, stale saves raise `PT409`, audited):

- `tenants.logo_storage_path`: the active logo, or null (the display name is
  shown). A foreign key makes it a registered logo of the same business.
- `tenants.brand_colors.primary`: `#rrggbb`, or absent for the default dark
  grey. Other keys are kept.

Suspended businesses can't change branding (`PT423`); archived ones follow
their existing settings rules.

**Logo uploads.**

- PNG, JPEG or WebP; never SVG, never animated. Up to 4 MB, at least 16 and at
  most 8000 pixels a side (`src/lib/branding/logo.server.ts`).
- The content is sniffed (`src/lib/media/sniff.ts`) and must agree with what
  the decoder finds; the declared type and extension are never trusted.
- The image is decoded and re-encoded server-side with `sharp`: EXIF
  orientation applied, metadata dropped, sRGB, fitted inside 1024 by 1024
  pixels without enlarging, stretching or cropping, transparency kept, saved
  as PNG (also usable by the PDF renderer later). Fully transparent images
  are refused; mostly light artwork is marked to be shown on a dark backdrop.
- The file reaches a Server Action (`serverActions.bodySizeLimit` is 4.5 MB,
  under Vercel's request limit), which uploads only the re-encoded PNG to the
  private `tenant-logos` bucket as `{tenant}/logos/{uuid}.png`, then
  registers it (`register_tenant_logo`, service role only, which rechecks the
  owner and the stored object). Only then can the save make it active.
- Nothing is ever fetched from a URL. The bucket has no Storage policies: logos
  are shown through one-hour signed URLs issued by the server after each
  page's own authorization (staff membership, proposal session, client access).
- Any failure (invalid file, upload, registration, stale save) leaves the
  current logo active. Uploads limited to 20 an hour per owner and 30 a day
  per business.

**Where branding appears.**

| Where | Branding |
|---|---|
| Staff workspace header | Current logo (alt text: the business name), else the name |
| Client contract and planning pages | Current logo and colour (invitation pages show the name only) |
| Proposals | Frozen when sent (`offer_snapshot.branding`): a sent proposal keeps its logo and colour after the owner changes them; staff previews of drafts use the current ones |
| Run sheet (page and PDF) | Current colour (unchanged) |
| Signed contract PDFs, emails | Unchanged; no logo (see below) |

Buttons and headers on a brand colour use white or black text, whichever
contrasts more (always at least 4.5:1, `src/lib/branding/colors.ts`). Errors,
warnings and disabled controls keep their own styles.

**Logos are never deleted.** A replacement gets a new path, so frozen
proposals keep resolving their logo, and registered logos can't be updated or
deleted by any role. `private.unused_tenant_logos()` (database owner only)
lists registered logos neither active nor frozen into a proposal, and stored
objects that never became a registered logo (an upload whose registration
failed and couldn't be removed). Clean-up stays a deliberate manual step.

**Deferred.** Signed contract PDFs and emails carry no logo. Adding one needs
the logo frozen into the contract's party snapshot at generation (the
snapshot point for contracts); canonical PDFs and contract hashes must not
change, so it is a separate task. The run-sheet PDF could use the current
logo (live branding) later. The Flux app icon, manifest and platform identity
stay shared by every business (see "Staff layout and navigation").

### Staff layout and navigation

Every page under `/staff/[tenant]` and `/platform` uses one shell
(`src/components/app/app-shell.tsx`); client proposal, contract and planning
pages don't.

- **Top bar:** the Flux wordmark (`public/brand/`, shared platform artwork
  generated from `assets/brand/` by `scripts/generate-app-icons.mjs`, never a
  business's logo) links to the business dashboard. The active business's logo,
  or its display name, is centred on the viewport (equal side columns), with
  the existing light-logo backdrop. Platform pages show "Platform
  administration" instead. The account menu shows the email, role and business,
  switches between the user's businesses (suspended ones are listed as
  unavailable), links to `/my` when the user also has client access, and signs
  out.
- **Navigation** (`src/lib/navigation.ts`): Main (Dashboard, Events, Clients),
  Catalog (Gear, Packages), Templates (Proposal, Contract and Planning
  templates, Questions & rules), Business (Emails, Settings), and Admin (DJ
  invitations, Workspaces) for platform administrators only, never for a
  tenant role. Links only point at existing routes and grant nothing; every
  page checks access again. Contracts, payments, planning and run sheets are
  reached through their event and highlight Events.
- **Sizes:** a sidebar from 1024 px; below that, a left drawer (focus trapped,
  Escape closes and returns focus, page scroll locked, closes after
  navigating). Safe areas, landscape and zoom are respected; nothing scrolls
  sideways at 320 px.
- **Look:** shared tokens in `globals.css` (`--shell` grey canvas, tinted
  `--sidebar`, white content surfaces). The staff shell looks the same for
  every business; business colours brand client pages.

### Staff dashboard

`/staff/[tenant]` answers "what's coming up, and what needs my attention?"
with one read-only call, `public.staff_dashboard` (migration
`20261021000100_staff_dashboard.sql`). The function returns facts; the
wording, order and links are in `src/lib/dashboard.ts`. It is `STABLE`, so it
can't change events, set up plans, confirm bookings, queue jobs or send
email. Only staff of the business can call it (others get "not found", and a
suspended workspace gets `workspace_suspended`). Archived events never
appear.

- **Upcoming events:** dated today or later in each event's own time zone,
  by date then title, the next 8, with client, venue ("Venue not set" when
  missing) and the existing status label (`eventStatusLabel`); booked events
  are shown apart. "View all events" opens the full Events list (not a
  filtered one).
- **Needs attention** (one item per task; an event can have several
  different tasks):
  - *Proposal ready to review:* the event's current proposal, submitted by
    the client and not approved yet. Links to the proposal.
  - *Planning closed with answers missing:* a booked event, today or later,
    whose client editing is closed while required answers are missing in
    available sections (`private.plan_progress`). Shown as urgent.
  - *Planning closes in N days:* the same, while editing is open and closes
    within **7 days**, or is reopened (closing when the reopening ends).
    Clients plan only after booking, so unbooked events are never listed.
  - *Signed · waiting for the deposit:* lifecycle `awaiting_deposit`, which
    only booking evaluation sets (deposit policy, deposit not received),
    with the outstanding amount from `private.event_payment_summary`. Signature
    policies, 0% deposits, booked events and unpaid balances never appear.
  - *Contract signed · booking not checked yet:* contracts signed before
    booking policies existed (no frozen policy) on events still awaiting
    signature. Once checked, an event waiting for its deposit moves to the
    deposit item instead.

  The first 6 show; "Show all N" (`?attention=all`) lists the rest.
- **Email failures:** a notice when this business's emails have status
  `failed` (retries used up), linking to Emails. Pending and sending emails,
  including normal retries, and platform invitation emails are not counted.
- **Setup checklist** (shown until complete; from saved data only): the legal
  name, address and contact email; taxes (at least one tax category, and
  every category used by active gear or packages configured; an empty list is
  a valid "no tax"); three active packages (every offer has three); an active
  proposal template whose three packages are all active; an active contract
  template with a version published for client use. Gear, a logo and
  planning templates are optional. Staff see which items only the owner can
  complete. The list checks what's saved, not whether terms or prices are
  right.
- **Quick actions:** New event and Add client open the existing screens. The
  compact install help stays.

**Deploying.** The migration only adds `public.staff_dashboard` (nothing
existing changes), and apps before it never call it, so apply it to the
hosted database first (`db push --linked --dry-run`, then `db push
--linked`), then deploy the app. An app deployed before the migration can't
load the dashboard; every other page works.

### Staff event page

`/staff/[tenant]/events/[eventId]` is an event workspace: a compact header
(date shown as a calendar date, never shifted; venue or "Venue not set";
type; the existing status label; Archived), one **next step**, four
summaries (proposal, contract, payments, planning), then the sections. The
rules are in `src/lib/events/workspace.ts` (unit-tested); rendering only
reads, so it never sets up a plan, books or sends anything. Every suggested
action is a link to the existing screen or form, where the database still
checks eligibility and asks for confirmation.

Next step, from the actual records (first match):

1. Archived: no action; the archive notice and Unarchive (#manage).
2. Cancelled or completed: nothing to do (run sheet if planned).
3. A signed contract: booked → Review planning (+ Open run sheet), or Set up
   planning when there is no plan; awaiting the deposit → Record payment
   (#record-payment, the outstanding amount from the payment summary); signed
   before booking rules and not checked → Check booking (#payments). A
   deposit corrected after booking keeps the booking and adds a warning.
4. A sent contract: waiting for the signature; View contract (resend, void
   and documents stay there).
5. A contract draft: Review contract (or Prepare contract when the draft
   can't be signed online).
6. A current approval without a contract: Prepare contract (#contract),
   unless the legal identity isn't saved or no template version is published,
   which are named with links instead.
7. A submitted proposal: Review submission.
8. A draft: Continue proposal.
9. A sent proposal: waiting for the client's choices; View proposal.
10. Expired or declined: Revise offer. Otherwise: Create proposal. A missing
    or archived primary contact is named (sending needs one).

Payments summaries come only from `private.event_payment_summary` (signed or
sent terms, labelled; received; deposit and what's still due; balance or
credit). Planning shows progress, the editing state and its closing time in
the event's time zone.

Where things are: Proposal (current revision, the start/revise form, older
revisions under "Proposal history"); Contract (current contract, generation,
older drafts and void contracts under "Contract history"); Payments (booking
state, summary, history; "Record a payment" and "Invoice link" open on
demand); Planning (Edit planning, Open run sheet); Contacts (primary and
signer labelled; "Add a contact" says whom a new primary replaces); Event
details (staff-only notes; "Edit details"); Manage event (archive). Anchors:
`#proposal`, `#contract`, `#payments`, `#record-payment`, `#invoice-link`,
`#planning`, `#contacts`, `#add-contact`, `#details`, `#edit-details`,
`#manage`. A link to a closed section opens it; a section with unsaved
edits or a failed save can't be collapsed. The dashboard's deposit and
booking-check items link to `#record-payment` and `#payments`.

### Events and Clients lists

Both lists share one pattern (`src/components/app/list.tsx`, filters in
`list-filters.tsx`): title and create action, a search and filter bar that is
a plain GET form (state in the URL; selects and checkboxes apply at once),
a result line, stacked rows, distinct empty states ("No events yet", "No
events match these filters", archived matches hidden) with Clear filters,
and 25 rows per page. Reads go through `public.staff_event_list` and
`public.staff_client_list` (migration
`20261022000100_staff_lists_client_archiving.sql`): read-only, staff of the
business only, searching every record server-side.

- **Events:** search title, venue and primary contact; Upcoming (default,
  nearest first), Past (most recent first) or All dates (latest first),
  each judged by the event's own time zone; status; Include archived (off by
  default). The earlier `?show=all` link still lists every date with
  archived events.
- **Clients:** active only by default; search name or email; Include
  archived; each row shows email, phone, and "Next event: Sat, Jun 12, 2027"
  (linked; "(Today)"/"(Tomorrow)" only when true in the event's time zone) or
  the event count. The header's Add client button (and the dashboard's
  `#add-client` link) reveals the form with its first field focused; Cancel
  asks before discarding typed details.

**Client archiving.** On the client page, Archive… asks for confirmation and
calls `public.set_client_archived`: it sets `archived_at` once (a repeat
changes nothing), records an audit event, and changes nothing else: events,
contact links, proposals, contracts, signed documents and client sign-ins
stay. Archived clients can't be chosen for new events or contacts; a
proposal can't be sent to an archived primary contact, nor a contract to an
archived signer, until they're restored (sending says so: "signer_archived",
migration `20261022000200_archived_signer_reason.sql`, distinct from a changed
signer, which still says to regenerate). Saving a client's details no longer
touches the archived state.

**Deploying.** The migrations only add functions and replace one private
check's wording, so apply them before the app
(`db push --linked --dry-run`, then `db push --linked`); the previous app
keeps working on the migrated database.

### Suspending and restoring a workspace

Migration `20261019000100_workspace_suspension.sql`. A platform
administrator suspends a workspace from `/platform/workspaces` (business
name, address, status, creation and suspension details only; no business
data) and restores it later. Suspension is separate from archiving
(`archived_at` keeps its meaning, and either can change without the other).

**Changing it.** `suspend_workspace` and `restore_workspace` take the
workspace's `suspension_version` and a required internal reason (3 to 500
characters). They lock the tenant row, so concurrent and repeated requests
take effect once: a repeat of a change that already happened returns it
(`replayed`), and a stale version for a change that didn't is a conflict
(`PT409`). Each change records the administrator, database time, reason and
new version in `platform_audit_events`. An administrator can't suspend a
workspace they belong to, and their administration never depends on their
own workspaces. `tenants.suspended_at` and `suspension_version` can't be
written any other way, by any role (a trigger checks a marker only these
functions set). Nothing is deleted: memberships, Auth identities and all
records stay.

**While suspended**, for the workspace only:

- *Staff* read nothing through RLS (`member_tenant_ids` and
  `owner_tenant_ids` leave it out), so tables, Storage gear media and
  signature images, staff functions and the staff PDF routes all refuse.
  `require_staff_of` answers members with `workspace_suspended` (`PT423`).
  Staff pages and Server Actions send members to `/unavailable` ("This
  workspace is unavailable"), on the next request of any open tab. `/staff`
  lists the workspace as unavailable. Non-members learn nothing.
- *Clients* lose that workspace's events (`client_event_ids`), contracts,
  signing, signed PDFs, signature images and payment summaries
  (`signer_can_access_contract`), planning, and contract invitations
  (`contract_invitation`): pages show their usual "not available" state.
  Proposal links open no session and existing sessions show and save
  nothing; both say "temporarily unavailable". Their events at other
  businesses are unaffected.
- *Every write* to the workspace's rows is refused for every role, including
  the service role and security definer functions
  (`private.tenant_write_guard`, `PT423`), except the append-only audit log
  and outbox and PDF-job bookkeeping. The guard takes a key-share lock on
  the tenant row, which the suspension's row lock waits for: a write already
  in progress finishes first, every later one is refused. Unsaved form input
  is never reported as saved.
- *Public pages* (invitation and proposal pages) see no such business.
- The internal reason and the administrator appear only on
  `/platform/workspaces` and in the platform audit log, never in member or
  client responses, emails or error text.

**Background work.**

- *Emails.* Suspension cancels the workspace's undelivered emails (pending,
  and claimed ones not yet sent) in the same transaction, so restoration
  never sends obsolete messages. Workers claim none of its emails while
  suspended, and the worker checks again right before handing each email to
  the provider (`email_outbox_dispatch_allowed`). An email already handed to
  the provider can't be recalled; that window is the provider call itself.
  Platform emails and other businesses' emails are unaffected.
- *Signed PDFs.* Jobs are kept and not claimed while suspended. A PDF
  rendered by a worker that claimed it just before the suspension isn't
  committed: the job goes back to pending without using an attempt and its
  upload is removed. After restoration the worker generates it as usual,
  and a job queued at signing then emails the signed copies, as it would
  have.
- PDFs and emails already delivered, and short-lived signed URLs already
  issued, can't be recalled.

**Restoring** only lifts the block. It sends no email, creates no link,
extends no link, session, invitation or planning deadline (expiry dates kept
running during the suspension), revives nothing that was revoked or
cancelled, and changes no booking, payment, signature or contract. Access
returns under the usual identity, membership, expiry, event, contract and
planning rules.

**Links are blocked, not revoked.** Proposal links and sessions and contract
invitations keep their rows and expiry, so a still-valid link works again
after restoration. Revoking them would force every client to be re-sent
links for a reversible, administrative action; the database blocks them
without exception while suspended.

### Client access

Clients never read `events` directly, because RLS limits rows, not columns.
They call `public.my_events()`, a hardened security definer function that
returns only client-safe columns for events with active access and a verified
email.

`event_access` rows can only be created by trusted server code using the
service role, after magic-link email verification (Phase 2). Staff can revoke
access but not grant it.

## Environment variables

See `.env.example`. Only `NEXT_PUBLIC_*` values reach the browser.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL (public) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key, `sb_publishable_…` (public). The legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY` is still read as a fallback. A secret or service-role key here is refused at startup. |
| `SUPABASE_SECRET_KEY` | Supabase secret key, `sb_secret_…`. Server only; bypasses RLS. The legacy `SUPABASE_SERVICE_ROLE_KEY` is still read as a fallback. A publishable or anon key here is refused. |
| `NEXT_PUBLIC_APP_URL` | The app's own origin, used in emailed links |
| `PROPOSAL_LINK_SECRET` | Derives proposal link tokens. 32 or more random characters. Rotating it fails undelivered proposal emails visibly; links already delivered keep working. |
| `EMAIL_TRANSPORT` | `mailpit` (local default), `resend` (hosted) or `disabled` (queue only) |
| `EMAIL_FROM_ADDRESS` | Sender address. Emails show "{DJ} via Flux DJ" with the DJ's reply-to address. |
| `MAILPIT_URL` | Local Mailpit, http://127.0.0.1:54324 |
| `RESEND_API_KEY` | Required only with `EMAIL_TRANSPORT=resend` |
| `OUTBOX_WORKER_SECRET` | Bearer secret for `/api/internal/outbox`. The endpoint returns 404 when it isn't set. |

Hosted configuration, still to review before real clients:
- Set every variable above as a server-side environment variable.
- Verify the sending domain in Resend.
- Schedule `/api/internal/outbox` with the worker secret, for example with
  Vercel Cron.
- Check that the platform's proxy sets `X-Forwarded-For`, which rate
  limiting uses.
- The Supabase magic-link template, redirect URLs and the disabled sign-up
  setting also need configuring.

The secret key bypasses RLS. It is read only through
`src/lib/env.server.ts`, which is marked `server-only`, so importing it into
client code fails the build. Never commit `.env.local`.

### Hosted setup

The production order, as followed for the hosted project. Apply migrations
only after reviewing a dry run, and keep the review gates in spec section 12
before real clients.

1. **Check the Supabase GitHub integration first.** With "deploy to
   production" enabled, pushing commits that contain `supabase/migrations`
   applies them to the hosted database. Keep it off until you intend to
   migrate.
2. **Link the CLI.** Run `pnpm exec supabase login`, then
   `pnpm exec supabase link --project-ref <ref>`. Linking records the project
   in `supabase/.temp`, which is git-ignored, and applies nothing.
3. **Inspect only.** `pnpm exec supabase migration list --linked` should
   show every migration as local-only. `pnpm exec supabase db push --dry-run`
   previews the push without applying it.
4. **Configure Auth in the dashboard** rather than with `supabase config push`,
   which would upload the local values, including the `127.0.0.1` URLs:
   - Turn off "Allow new users to sign up". Invited clients are still
     created by trusted server code.
   - Set the Site URL to the production origin.
   - Add `https://<domain>/auth/confirm` to the redirect URLs.
   - Paste `supabase/templates/magic_link.html` into the Magic Link template.
     It carries both the link and the 6-digit code (`{{ .Token }}`) that the
     home-screen app signs in with; keep both when editing it.
   - Keep the email OTP expiry at 3600 seconds.
   - Configure custom SMTP (Resend). Supabase's built-in mailer is heavily
     rate-limited and meant for testing.
5. **Never run `supabase/seed.sql` on hosted.** It creates DEMO users and
   tenants. `db push` does not seed unless you pass `--include-seed`.
6. **Set Vercel environment variables:**
   - the four from the table above (Supabase URL, publishable key, secret
     key, app URL)
   - a new `PROPOSAL_LINK_SECRET` and `OUTBOX_WORKER_SECRET`, each 32 or more
     random characters, never reused from local
   - `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY` and a verified
     `EMAIL_FROM_ADDRESS`
7. **Platform administration (DJ invitations).** After migration
   `20261018000100` is applied, grant your own identity once from the SQL
   editor (see "DJ invitations and new workspaces"). No new environment
   variables or Auth settings are needed: invitations reuse
   `PROPOSAL_LINK_SECRET` with their own prefix, and verification links use
   the existing `/auth/confirm` redirect.
8. **Schedule the outbox worker.** It also generates signed PDFs (up to 5 per run, before emails, `maxDuration` 60 s; a PDF usually renders in well under 2 s). `vercel.json` runs `/api/internal/outbox`
   every 5 minutes. Vercel cron sends `Authorization: Bearer $CRON_SECRET`, and
   only when a `CRON_SECRET` variable exists. The route accepts exactly
   `Bearer $OUTBOX_WORKER_SECRET`, so set `CRON_SECRET` (Production,
   Sensitive) to the same value as `OUTBOX_WORKER_SECRET`. A mismatch shows as
   404s in the cron logs.
   - Emails still go out immediately after each action. The cron only retries
     and catches up.
   - Schedules more frequent than once a day need a Vercel Pro plan; on Hobby
     the deployment fails.
   - Vercel can occasionally skip or repeat a run, which the outbox tolerates:
     claims skip locked rows, and every email has a dedup key.

Locally verified with the new key formats: service-role RPCs, Auth admin
(`generateLink`), Storage, anon denial, magic-link verification, RLS reads,
the proxy's `getClaims`, the SSR client, and the integration suite through
`SUPABASE_SECRET_KEY` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The local
gateway does not reject secret keys sent from a browser; hosted Supabase
does.

## Project layout

```
docs/                          Product and data specification
src/app/                       Next.js routes (placeholder home page for now)
src/components/ui/             shadcn/ui components
src/lib/env.ts, env.server.ts  Validated public and server-only environment
src/lib/supabase/              Browser, server and admin clients, generated DB types
supabase/migrations/           SQL migrations (source of truth for the schema)
supabase/tests/database/       pgTAP RLS, constraint and Storage policy tests
src/lib/pricing/               Pure pricing module and offer snapshot schema
src/lib/proposals/             Server-only selection pricing and recording
src/app/staff/                 Staff screens and Server Actions
src/app/login, src/app/auth/   Magic-link login and confirmation
src/app/platform/              Platform administrators: DJ invitations and workspace suspension
src/app/unavailable/           Shown to members of a suspended workspace
src/lib/branding/              Brand colours and contrast; logo verification, storage and signed URLs
src/app/join/                  Invited DJs: verification request and workspace creation
src/components/proposal/       Responsive proposal preview (live pricing)
src/lib/media/                 File-signature detection for uploads
src/lib/proposals/             Link tokens and the client proposal session
src/lib/email/                 Email templates, transports (Mailpit/Resend) and outbox worker
src/lib/contracts/             Template text format, rendered-content schema, DEMO template text
src/components/contract/       Readable, escaped contract document view
src/app/staff/[tenant]/contract-templates/  Template list, editor and publishing
src/app/staff/[tenant]/contracts/          Contract generation panel and draft preview
src/app/[tenant]/p/            Link opener and token exchange (public)
src/app/[tenant]/proposals/    Client proposal page (session cookie)
src/app/api/internal/outbox/   Outbox worker endpoint (secret required)
scripts/outbox-worker.mjs      Local worker loop (pnpm outbox:work)
tests/unit/                    Vitest unit tests (pricing, uploads, money)
tests/e2e/                     Playwright browser tests
tests/integration/             Vitest tests against local Supabase (offers, Storage)
supabase/seed.sql              Local-only seed data
```

## Adding a tenant-owned table

1. Add `tenant_id uuid not null`, `unique (tenant_id, id)` and composite
   foreign keys to parents.
2. Add the `set_updated_at` and `forbid_column_changes` triggers.
   Add stable keys and parent references to the immutable list.
3. If a CHECK constraint calls a new function, grant EXECUTE on it to
   `authenticated` and `service_role`. Default privileges deny it, and a
   schema guard test fails if it is missing.
4. Enable RLS and grant only the needed privileges, column by column for
   writes. Catalog-style records get no DELETE; archive them with `active`.
5. Add tests for SELECT, INSERT, UPDATE and DELETE from another tenant, and
   for client and anon access.
6. Run `pnpm db:types` and `pnpm check`.
