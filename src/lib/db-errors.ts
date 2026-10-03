/** Turns Postgres/PostgREST errors into messages safe to show staff. */
export function describeDbError(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return "Something went wrong.";
  const message = error.message ?? "";
  const offer = /offer_invalid: (.*)$/.exec(message);
  if (offer) return `This offer isn't ready: ${offer[1]}.`;
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
