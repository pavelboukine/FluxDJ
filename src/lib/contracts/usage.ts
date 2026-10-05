/** How a published contract template version may be used (contract_template_versions.usage). */
export type TemplateUsage = "demo" | "client_use" | "legacy";
/** A contract's frozen signing mode (contracts.signing_mode). */
export type SigningMode = "demo" | "client_use" | "none";

export const USAGE_LABELS: Record<TemplateUsage, string> = {
  demo: "DEMO",
  client_use: "client use",
  legacy: "published before client use, not signable",
};

export const SIGNING_MODE_LABELS: Record<SigningMode, string> = {
  demo: "DEMO signing",
  client_use: "Client use",
  none: "Can't be signed online",
};
