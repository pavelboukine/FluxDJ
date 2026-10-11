import type { DashboardFacts } from "@/lib/dashboard";

/**
 * The setup guide (/staff/{tenant}/setup) and the dashboard's setup card.
 * Everything is derived from saved data: there is no onboarding state, so a
 * task is ready exactly when the business can do what it unlocks.
 *
 * - required: the app refuses the workflow without it (sending a proposal:
 *   taxes for its categories and three active packages; sending a contract:
 *   the legal identity and a template version published for client use).
 * - recommended: has a working default or a manual alternative (deposit and
 *   booking policy defaults, proposal templates, planning defaults).
 * - optional: nothing depends on it (logo, gear, questions, first event).
 *
 * Completing it doesn't mean terms or prices are right.
 */

export type SetupLevel = "required" | "recommended" | "optional";
export type SetupStatus = "ready" | "attention" | "not_started" | "optional";

export const STATUS_LABEL: Record<SetupStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  not_started: "Not started",
  optional: "Optional",
};

export type SetupTask = {
  key: string;
  label: string;
  /** What it is and why it matters. */
  description: string;
  level: SetupLevel;
  /** What it unlocks, e.g. "Needed to send contracts". */
  needed: string;
  done: boolean;
  status: SetupStatus;
  /** The current saved state, in a sentence. */
  hint: string;
  href: string;
  action: string;
  ownerOnly: boolean;
};

export type SetupGroup = { key: string; title: string; tasks: SetupTask[] };

/**
 * The dashboard's saved-setup facts, plus how many active packages can be
 * offered: build_offer_snapshot also refuses a package whose included gear
 * is archived, and gear can be archived while a package still includes it.
 */
type Base = DashboardFacts["setup"] & { offerable_packages: number };

/** Package rows selected with `package_items(gear_items!package_items_gear_item_fk(active))`. */
export type PackageGearRow = { package_items: { gear_items: { active: boolean } | null }[] };

/** Active packages whose included gear is all active (the package rule of build_offer_snapshot). */
export function offerablePackages(activePackages: PackageGearRow[]): number {
  return activePackages.filter((p) => p.package_items.every((i) => i.gear_items?.active === true)).length;
}

/** Saved facts the setup guide reads beyond the dashboard's (RLS-scoped selects on the page). */
export type SetupExtras = {
  hasLogo: boolean;
  hasBrandColor: boolean;
  depositPercent: number;
  bookingPolicy: string;
  /** update_booking_policy has been saved at least once (the version starts at 0). */
  bookingPolicyReviewed: boolean;
  activeGear: number;
  activeQuestions: number;
  activeContractTemplates: number;
  activePlanningTemplates: number;
  /** Event type labels with a default planning template. */
  planningDefaults: string[];
  planningLockDays: number;
  events: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function status(level: SetupLevel, done: boolean, started: boolean): SetupStatus {
  if (done) return "ready";
  if (level === "optional") return "optional";
  return started ? "attention" : "not_started";
}

function task(t: Omit<SetupTask, "status"> & { started?: boolean }): SetupTask {
  const { started = false, ...rest } = t;
  return { ...rest, status: status(t.level, t.done, started) };
}

/** The steps without which proposals or contracts can't be sent. Only needs the dashboard's facts. */
export function requiredSetup(s: Base, slug: string): SetupTask[] {
  const base = `/staff/${slug}`;
  const configured = new Set(s.tax_categories);
  const unconfigured = s.used_tax_categories.filter((c) => !configured.has(c));
  return [
    task({
      key: "identity",
      label: "Business details",
      description: "Your legal business name, address and contact email. New contracts copy them when they are generated.",
      level: "required",
      needed: "Needed to send contracts",
      done: s.identity_saved,
      hint: s.identity_saved ? "Saved." : "Not saved yet: contracts can't be sent until they are.",
      href: `${base}/settings`,
      action: "Add business details",
      ownerOnly: true,
    }),
    task({
      key: "taxes",
      label: "Taxes",
      description: 'The taxes you charge and which ones apply to each tax category. "No tax" is a valid choice.',
      level: "required",
      needed: "Needed to send proposals",
      done: configured.size > 0 && unconfigured.length === 0,
      started: configured.size > 0,
      hint:
        unconfigured.length > 0
          ? `Set taxes for ${unconfigured.join(", ")} (used by active gear or packages).`
          : configured.size > 0
            ? `${plural(configured.size, "tax category", "tax categories")} configured.`
            : "Nothing configured yet: proposals can't be sent until it is.",
      href: `${base}/settings#taxes`,
      action: "Set up taxes",
      ownerOnly: true,
    }),
    task({
      key: "packages",
      label: "Three packages",
      description: "Every proposal offers exactly three packages to choose from. Each has one fixed price; the gear it includes isn't charged again.",
      level: "required",
      needed: "Needed to send proposals",
      done: s.offerable_packages >= 3,
      started: s.active_packages > 0,
      hint:
        s.offerable_packages < s.active_packages
          ? `${s.offerable_packages} of 3 packages can be offered: ${plural(s.active_packages - s.offerable_packages, "active package includes", "active packages include")} archived gear.`
          : s.offerable_packages >= 3
            ? `${plural(s.offerable_packages, "active package")}.`
            : `${s.offerable_packages} of 3 active packages.`,
      href: `${base}/packages`,
      action: "Add packages",
      ownerOnly: false,
    }),
    task({
      key: "contract-template",
      label: "Contract template",
      description: "Import the agreement you use in Word or write one, preview it, then publish a version for client use. DEMO versions can't be sent.",
      level: "required",
      needed: "Needed to send contracts",
      done: s.client_use_contract_templates > 0,
      hint: s.client_use_contract_templates > 0 ? "A version is published for client use." : "No version published for client use yet.",
      href: `${base}/contract-templates`,
      action: "Prepare a contract",
      ownerOnly: true,
    }),
  ];
}

/** Every step of the setup guide, in the order a new business usually takes them. */
export function setupGuide(s: Base, x: SetupExtras, slug: string): SetupGroup[] {
  const base = `/staff/${slug}`;
  const required = new Map(requiredSetup(s, slug).map((t) => [t.key, t]));
  const policy = x.bookingPolicy === "on_signature" ? "confirmed when the contract is signed" : "confirmed when the contract is signed and the deposit is received";
  const contractTemplate = required.get("contract-template")!;

  return [
    {
      key: "business",
      title: "Your business",
      tasks: [
        required.get("identity")!,
        task({
          key: "branding",
          label: "Customize branding",
          description: "Your logo and brand colour, shown on your client pages and on proposals you send. Without them, clients see your business name in Flux's default style.",
          level: "optional",
          needed: "Optional: makes your client pages look like yours",
          done: x.hasLogo || x.hasBrandColor,
          hint:
            x.hasLogo && x.hasBrandColor
              ? "Logo and brand colour configured."
              : x.hasLogo
                ? "Logo added."
                : x.hasBrandColor
                  ? "Brand colour configured."
                  : "Add your logo or choose a brand colour.",
          href: `${base}/settings#branding`,
          action: "Add branding",
          ownerOnly: true,
        }),
        task({
          key: "booking",
          label: "Deposit and booking confirmation",
          description: "How much deposit is due on signing, and when Flux confirms a booking and emails the client.",
          level: "recommended",
          needed: "Recommended: the defaults work until you change them",
          done: s.identity_saved && x.bookingPolicyReviewed,
          started: s.identity_saved || x.bookingPolicyReviewed,
          hint: `${x.depositPercent}% deposit; bookings ${policy}.${x.bookingPolicyReviewed && s.identity_saved ? "" : " Not reviewed yet."}`,
          href: `${base}/settings#booking`,
          action: "Review booking settings",
          ownerOnly: true,
        }),
      ],
    },
    {
      key: "offer",
      title: "What you offer",
      tasks: [
        required.get("taxes")!,
        task({
          key: "gear",
          label: "Gear and services",
          description: "What you bring or offer, such as a DJ service, ceremony speaker or uplighting. Include it in packages or offer it as an extra.",
          level: "optional",
          needed: "Optional: packages can be priced without gear",
          done: x.activeGear > 0,
          hint: x.activeGear > 0 ? `${plural(x.activeGear, "active item")}.` : "No gear yet.",
          href: `${base}/gear`,
          action: "Add gear",
          ownerOnly: false,
        }),
        required.get("packages")!,
        task({
          key: "proposal-template",
          label: "Proposal template",
          description: "Saves your three packages, extras and questions so each new proposal starts ready. You can also choose packages on each proposal.",
          level: "recommended",
          needed: "Recommended: saves time on every proposal",
          done: s.usable_proposal_templates > 0,
          hint: s.usable_proposal_templates > 0 ? `${plural(s.usable_proposal_templates, "usable template")}.` : "No template with three active packages yet.",
          href: `${base}/templates`,
          action: "Create a proposal template",
          ownerOnly: false,
        }),
        task({
          key: "questions",
          label: "Questions & rules",
          description: "Logistics questions on proposals, such as where the ceremony takes place, and the gear each answer adds.",
          level: "optional",
          needed: "Optional: only if an answer changes the gear you bring",
          done: x.activeQuestions > 0,
          hint: x.activeQuestions > 0 ? `${plural(x.activeQuestions, "active question")}.` : "No questions yet.",
          href: `${base}/questions`,
          action: "Add questions",
          ownerOnly: false,
        }),
      ],
    },
    {
      key: "contracts",
      title: "Contracts and planning",
      tasks: [
        {
          ...contractTemplate,
          status: contractTemplate.done ? "ready" : x.activeContractTemplates > 0 ? "attention" : "not_started",
          hint: contractTemplate.done
            ? contractTemplate.hint
            : x.activeContractTemplates > 0
              ? `${plural(x.activeContractTemplates, "template")}, none published for client use yet.`
              : contractTemplate.hint,
        },
        task({
          key: "planning",
          label: "Planning template",
          description: `What booked clients fill in before the event. Each event gets its own copy when planning starts, so later template changes don't alter it. Client planning closes ${plural(x.planningLockDays, "day")} before the event.`,
          level: "recommended",
          needed: "Recommended: without a default, planning starts with event basics only",
          done: x.planningDefaults.length > 0,
          started: x.activePlanningTemplates > 0,
          hint:
            x.planningDefaults.length > 0
              ? `Default for ${x.planningDefaults.join(", ")} events.`
              : x.activePlanningTemplates > 0
                ? `${plural(x.activePlanningTemplates, "template")}, not yet the default for any event type.`
                : "No planning templates yet. Wedding and Simple Party starters are available.",
          href: `${base}/planning-templates`,
          action: "Choose a planning template",
          ownerOnly: false,
        }),
      ],
    },
    {
      key: "start",
      title: "Start working",
      tasks: [
        task({
          key: "first-event",
          label: "Your first event",
          description: "Create an event and add its client. Nothing is sent to the client until you send them a proposal.",
          level: "optional",
          needed: "When you're ready",
          done: x.events > 0,
          hint: x.events > 0 ? `${plural(x.events, "event")}.` : "No events yet.",
          href: `${base}/events/new`,
          action: "Create an event",
          ownerOnly: false,
        }),
      ],
    },
  ];
}

/** What the saved setup allows today. A contract also needs an approved proposal, so it follows proposal readiness. */
export function readiness(s: Base) {
  const tasks = requiredSetup(s, "");
  const missing = (keys: string[]) => tasks.filter((t) => keys.includes(t.key) && !t.done).map((t) => t.label);
  const proposals = missing(["taxes", "packages"]);
  const contracts = [...proposals, ...missing(["identity", "contract-template"])];
  return { proposals, contracts, readyCount: tasks.filter((t) => t.done).length, total: tasks.length };
}

/** A setup guide link to a page, marked so that page offers the way back (SetupReturn). Keeps any #section. */
export function fromSetup(href: string): string {
  const [path, hash] = href.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}from=setup${hash ? `#${hash}` : ""}`;
}
