const TAX_SETUP_HINT = "The owner can set them up in Settings, under Taxes.";

/** Whether a message from describeDbError is fixed in the tax settings (pages add a link). */
export function needsTaxSetup(message: string): boolean {
  return message.includes(TAX_SETUP_HINT);
}

/** Turns Postgres/PostgREST errors into messages safe to show staff. */
export function describeDbError(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return "Something went wrong.";
  const message = error.message ?? "";
  const offer = /offer_invalid: (.*)$/.exec(message);
  if (offer) {
    if (/^tax categories not configured/.test(offer[1])) return `This offer isn't ready: ${offer[1]}. ${TAX_SETUP_HINT}`;
    return `This offer isn't ready: ${offer[1]}.`;
  }
  const settings = /settings_invalid: (.*)$/.exec(message);
  if (settings) return `Check the settings: ${settings[1]}.`;
  const archived = /event_archived: (.*)$/.exec(message);
  if (archived) return `${archived[1]}.`;
  const template = /contract_template_invalid: (.*)$/.exec(message);
  if (template) return `This template can't be used: ${template[1]}.`;
  const sending = /contract_(?:not_sendable|not_resendable|resend_too_soon|void_invalid): (.*)$/.exec(message);
  if (sending) return `${sending[1].charAt(0).toUpperCase()}${sending[1].slice(1)}${/[.!?]$/.test(sending[1]) ? "" : "."}`;
  const document = /contract_document_invalid: (.*)$/.exec(message);
  if (document) return `${document[1].charAt(0).toUpperCase()}${document[1].slice(1)}.`;
  const contract = /contract_(?:stale_approval|not_allowed|input_invalid): (.*)$/.exec(message);
  if (contract) return `A contract can't be generated: ${contract[1]}.`;
  switch (error.code) {
    case "23505":
      return "That key or value is already used. Choose another.";
    case "23503":
      return "This refers to a record that doesn't exist, belongs elsewhere, or is still in use.";
    case "23514":
      if (/immutable|frozen/.test(message)) return "This value can't be changed once set.";
      return "Some values aren't allowed. Check the form and try again.";
    case "22023":
      return message || "Some values aren't allowed.";
    case "40001":
      return "Someone else saved changes first. Reload the page to see them, then try again.";
    case "42501":
      return "You don't have permission to do that.";
    case "P0002":
      return "Not found.";
    default:
      return "Something went wrong. Try again.";
  }
}
