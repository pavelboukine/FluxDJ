import type { DashboardFacts } from "@/lib/dashboard";

/**
 * The setup guide (/staff/{tenant}/setup) and the dashboard's setup card.
 * Every step's status is derived from saved data, so a task is ready exactly
 * when the business can do what it unlocks.
 *
 * - required: the app refuses the workflow without it (sending a proposal:
 *   taxes for its categories and three active packages; sending a contract,
 *   with or without a proposal first: the legal identity and a template version
 *   published for client use). A proposal-based booking needs both; an event
 *   booked elsewhere needs neither.
 * - recommended: has a working default or a manual alternative (deposit and
 *   booking policy defaults, proposal templates, planning defaults).
 * - optional: nothing depends on it (logo, gear, questions, first event).
 *
 * Each step belongs to the workflow it serves (proposals or contracts), or to
 * none. The business's setup guidance (tenants.setup_guidance, owner-chosen)
 * says which workflows to remind about: the dashboard lists only their missing
 * required steps, and the guide marks the other workflows' unfinished steps
 * "Skipped". It is guidance only: a finished step is always Ready, readiness()
 * always reports both workflows honestly, and each proposal and contract is
 * still checked when it's sent.
 *
 * Completing it doesn't mean terms or prices are right.
 */

export type SetupLevel = "required" | "recommended" | "optional";
export type SetupStatus = "ready" | "attention" | "not_started" | "optional" | "skipped";
export type SetupWorkflow = "proposals" | "contracts";

/** tenants.setup_guidance. There is no proposals-only choice: a proposal booking always ends in a contract. */
export type SetupGuidance = "proposals_and_contracts" | "contracts_only" | "none";

/** The workflows each choice reminds about, contracts first: every booking made in Flux DJ ends in one. */
export const GUIDANCE_WORKFLOWS: Record<SetupGuidance, readonly SetupWorkflow[]> = {
  proposals_and_contracts: ["contracts", "proposals"],
  contracts_only: ["contracts"],
  none: [],
};

/** The choices, as the setup guide offers them. */
export const GUIDANCE_OPTIONS: readonly { value: SetupGuidance; label: string; description: string }[] = [
  { value: "proposals_and_contracts", label: "Proposals and contracts", description: "For businesses that send proposals before booking events." },
  { value: "contracts_only", label: "Contracts only", description: "For businesses that book directly without proposals." },
  { value: "none", label: "Planning only", description: "For businesses managing events booked elsewhere." },
];

export function isSetupGuidance(value: unknown): value is SetupGuidance {
  return value === "proposals_and_contracts" || value === "contracts_only" || value === "none";
}

export const STATUS_LABEL: Record<SetupStatus, string> = {
  ready: "Ready",
  attention: "Needs attention",
  not_started: "Not started",
  optional: "Optional",
  skipped: "Skipped",
};

/**
 * What a task says about itself. A recommended step that isn't done has a working
 * default, so it never reads as a problem; "Needs attention" is for what blocks a workflow.
 */
export function taskStatusLabel(task: Pick<SetupTask, "level" | "done" | "status">): string {
  return task.level === "recommended" && !task.done && task.status !== "skipped" ? "Recommended" : STATUS_LABEL[task.status];
}

export type SetupTask = {
  key: string;
  label: string;
  /** What it is and why it matters. */
  description: string;
  level: SetupLevel;
  /** The workflow it serves, or null when it serves every workflow. */
  workflow: SetupWorkflow | null;
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

/** skipped: the group's workflow isn't in the business's setup guidance. */
export type SetupGroup = { key: string; title: string; description: string; skipped: boolean; tasks: SetupTask[] };

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
  /** update_booking_policy has been saved at least once (the version starts at 0, and every save increments it). */
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
      workflow: "contracts",
      needed: "Needed to send contracts",
      done: s.identity_saved,
      hint: s.identity_saved ? "Saved." : "Not saved yet: contracts can't be sent until they are.",
      href: `${base}/settings/profile`,
      action: "Add business details",
      ownerOnly: true,
    }),
    task({
      key: "taxes",
      label: "Taxes",
      description: 'The taxes you charge and which ones apply to each tax category. "No tax" is a valid choice.',
      level: "required",
      workflow: "proposals",
      needed: "Needed to send proposals",
      done: configured.size > 0 && unconfigured.length === 0,
      started: configured.size > 0,
      hint:
        unconfigured.length > 0
          ? `Set taxes for ${unconfigured.join(", ")} (used by active gear or packages).`
          : configured.size > 0
            ? `${plural(configured.size, "tax category", "tax categories")} configured.`
            : "Nothing configured yet: proposals can't be sent until it is.",
      href: `${base}/settings/taxes`,
      action: "Set up taxes",
      ownerOnly: true,
    }),
    task({
      key: "packages",
      label: "Three packages",
      description: "Every proposal offers exactly three packages to choose from. Each has one fixed price; the gear it includes isn't charged again.",
      level: "required",
      workflow: "proposals",
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
      action: "Create packages",
      ownerOnly: false,
    }),
    task({
      key: "contract-template",
      label: "Contract template",
      description: "Import the agreement you use in Word or write one, preview it, then publish a version for client use. DEMO versions can't be sent.",
      level: "required",
      workflow: "contracts",
      needed: "Needed to send contracts",
      done: s.client_use_contract_templates > 0,
      hint: s.client_use_contract_templates > 0 ? "A version is published for client use." : "No version published for client use yet.",
      href: `${base}/contract-templates`,
      action: "Prepare a contract",
      ownerOnly: true,
    }),
  ];
}

/**
 * Every step of the setup guide, grouped in the order a new business usually takes them.
 * A step that isn't done reads "Skipped" when its workflow isn't in the setup guidance;
 * a done step stays Ready, whatever the guidance.
 */
export function setupGuide(s: Base, x: SetupExtras, slug: string, guidance: SetupGuidance): SetupGroup[] {
  const reminded = GUIDANCE_WORKFLOWS[guidance];
  const skipped = (w: SetupWorkflow | null) => w !== null && !reminded.includes(w);
  return guideGroups(s, x, slug).map((g) => ({
    ...g,
    skipped: skipped(g.key === "proposals" ? "proposals" : g.key === "contracts" ? "contracts" : null),
    tasks: g.tasks.map((t) => (!t.done && skipped(t.workflow) ? { ...t, status: "skipped" as const } : t)),
  }));
}

function guideGroups(s: Base, x: SetupExtras, slug: string): Omit<SetupGroup, "skipped">[] {
  const base = `/staff/${slug}`;
  const required = new Map(requiredSetup(s, slug).map((t) => [t.key, t]));
  const policy = x.bookingPolicy === "on_signature" ? "confirmed when the contract is signed" : "confirmed when the contract is signed and the deposit is received";
  const contractTemplate = required.get("contract-template")!;

  return [
    {
      key: "business",
      title: "Business",
      description: "Who you are, on your contracts and client pages.",
      tasks: [
        required.get("identity")!,
        task({
          key: "branding",
          label: "Customize branding",
          description: "Your logo and brand colour, shown on your client pages and in emails from your business. Without them, clients see your business name in Flux's default style.",
          level: "optional",
          workflow: null,
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
          href: `${base}/settings/branding`,
          action: "Add branding",
          ownerOnly: true,
        }),
      ],
    },
    {
      key: "proposals",
      title: "Proposals",
      description: "What clients choose from before they book. Only needed if you send proposals.",
      tasks: [
        required.get("taxes")!,
        task({
          key: "gear",
          label: "Gear and services",
          description: "What you bring or offer, such as a DJ service, ceremony speaker or uplighting. Include it in packages or offer it as an extra.",
          level: "optional",
          workflow: "proposals",
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
          workflow: "proposals",
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
          workflow: "proposals",
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
      title: "Contracts",
      description: "What clients sign to book you, with or without a proposal first.",
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
          key: "booking",
          label: "Deposit and booking confirmation",
          description: "How much deposit is due on signing, and when Flux confirms a booking and emails the client. Each new contract keeps the settings it was generated with.",
          level: "recommended",
          workflow: "contracts",
          needed: "Recommended: the defaults work until you change them",
          // Reviewed once the booking policy has been saved; legal details have their own step.
          done: x.bookingPolicyReviewed,
          hint: `${x.depositPercent}% deposit; bookings ${policy}.${x.bookingPolicyReviewed ? "" : " Not reviewed yet."}`,
          href: `${base}/settings/bookings`,
          action: "Review booking settings",
          ownerOnly: true,
        }),
      ],
    },
    {
      key: "planning",
      title: "Planning",
      description: "What booked clients fill in before the event, for every kind of booking.",
      tasks: [
        task({
          key: "planning",
          label: "Planning template",
          description: `Each event gets its own copy when planning starts, so later template changes don't alter it. Client planning closes ${plural(x.planningLockDays, "day")} before the event.`,
          level: "recommended",
          workflow: null,
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
      title: "Getting started",
      description: "",
      tasks: [
        task({
          key: "first-event",
          label: "Your first event",
          description: "Create an event and add its client. Nothing is sent to the client until you send them a proposal, a contract or a planning invitation.",
          level: "optional",
          workflow: null,
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

/**
 * What the saved setup allows today, by workflow: the required steps still missing.
 * Contracts don't depend on proposal setup: a contract-only booking needs neither taxes nor packages.
 * Never affected by which workflows the business wants reminders about.
 */
export function readiness(s: Base): Record<SetupWorkflow, string[]> {
  const tasks = requiredSetup(s, "");
  const missing = (w: SetupWorkflow) => tasks.filter((t) => t.workflow === w && !t.done).map((t) => t.label);
  return { proposals: missing("proposals"), contracts: missing("contracts") };
}

export const WORKFLOW_LABEL: Record<SetupWorkflow, string> = { proposals: "Proposals", contracts: "Contracts" };

/** The dashboard card: the missing required steps of the given workflows, one entry per workflow that isn't ready. */
export function reminders(s: Base, slug: string, workflows: readonly SetupWorkflow[]): { workflow: SetupWorkflow; tasks: SetupTask[] }[] {
  const tasks = requiredSetup(s, slug);
  return workflows
    .map((workflow) => ({ workflow, tasks: tasks.filter((t) => t.workflow === workflow && !t.done) }))
    .filter((r) => r.tasks.length > 0);
}

/** A setup guide link to a page, marked so that page offers the way back (SetupReturn). Keeps any #section. */
export function fromSetup(href: string): string {
  const [path, hash] = href.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}from=setup${hash ? `#${hash}` : ""}`;
}
