import { sectionsToText, type TemplateSection } from "./template-text";

/**
 * DEMO starting text for a new contract template. It exists only to exercise
 * placeholders, pricing and rendering locally. It is NOT a reviewed agreement:
 * it deliberately contains no cancellation, refund, liability or other legal
 * terms, and must be replaced with reviewed wording before any client use.
 */
export const DEMO_TEMPLATE_NAME = "DJ services agreement (DEMO)";
export const DEMO_TEMPLATE_TITLE = "DEMO, NOT FOR CLIENT USE: DJ services agreement for {{event.title}}";

export const DEMO_TEMPLATE_SECTIONS: TemplateSection[] = [
  {
    heading: "About this document",
    body:
      "DEMO, NOT FOR CLIENT USE. This is placeholder text for testing Flux DJ contract templates. " +
      "It has not been reviewed by a lawyer and is not a real agreement. Replace it with reviewed wording before sending anything to a client.",
  },
  {
    heading: "Parties",
    body: "Business: {{business.name}}\nClient: {{client.name}}, {{client.email}}, {{client.phone}}",
  },
  {
    heading: "Event",
    body: "Event: {{event.title}}\nDate: {{event.date}}\nVenue: {{venue.name}}, {{venue.address}}",
  },
  {
    heading: "Services and gear",
    body: "Package: {{package.name}} ({{package.price}})\n\nIncluded in the package:\n{{package.included}}\n\nAdditional gear:\n{{gear.extras}}",
  },
  {
    heading: "Price",
    body: "Subtotal: {{pricing.subtotal}}\nTaxes:\n{{pricing.taxes}}\nTotal taxes: {{pricing.tax_total}}\nTotal: {{pricing.total}}",
  },
  {
    heading: "Payment",
    body:
      "Deposit due on signing ({{payment.deposit_percent}} of the total including taxes): {{payment.deposit}}\n" +
      "Remaining balance: {{payment.balance}}, due {{payment.balance_due_date}}.",
  },
  {
    heading: "Terms not included",
    body:
      "DEMO: This text contains no cancellation, refund, liability or other legal terms. " +
      "Those must come from a reviewed agreement.",
  },
];

export const DEMO_TEMPLATE_TEXT = sectionsToText(DEMO_TEMPLATE_SECTIONS);
