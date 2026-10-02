import type { OfferSnapshot } from "@/lib/pricing";

/**
 * A frozen offer shaped like the BOUPROD demo catalog. Mirrors the spec's
 * example: separate ceremony and cocktail spaces each require an
 * additional-location speaker; Signature includes one. The main reception
 * system is a different key and never counts as an additional speaker.
 */
export function demoOffer(): OfferSnapshot {
  return {
    schema_version: 1,
    currency: "CAD",
    intro: "Demo intro",
    expiry_days: 14,
    branding: { display_name: "BOUPROD", logo_storage_path: null, brand_colors: { primary: "#111827" } },
    tax: {
      rounding: "per_line_per_tax_half_up",
      rates: [
        { code: "GST", label: "GST", rate_ppm: 50_000 },
        { code: "QST", label: "QST", rate_ppm: 99_750 },
      ],
      categories: { standard: ["GST", "QST"], exempt: [] },
    },
    packages: [
      {
        key: "essential",
        name: "Essential",
        description: null,
        base_price_cents: 150_000,
        tax_category: "standard",
        is_popular: false,
        included: [
          { gear_key: "main_sound_system", quantity: 1 },
          { gear_key: "wireless_mic", quantity: 1 },
        ],
      },
      {
        key: "signature",
        name: "Signature",
        description: null,
        base_price_cents: 220_000,
        tax_category: "standard",
        is_popular: true,
        included: [
          { gear_key: "additional_location_speaker", quantity: 1 },
          { gear_key: "main_sound_system", quantity: 1 },
          { gear_key: "wireless_mic", quantity: 2 },
        ],
      },
      {
        key: "premium",
        name: "Premium",
        description: null,
        base_price_cents: 300_000,
        tax_category: "standard",
        is_popular: false,
        included: [
          { gear_key: "additional_location_speaker", quantity: 2 },
          { gear_key: "main_sound_system", quantity: 1 },
          { gear_key: "uplights_4", quantity: 2 },
          { gear_key: "wireless_mic", quantity: 2 },
        ],
      },
    ],
    gear: {
      main_sound_system: gear("main_sound_system", "Main reception sound system", 0),
      additional_location_speaker: gear("additional_location_speaker", "Additional-location speaker", 15_000),
      wireless_mic: gear("wireless_mic", "Wireless microphone", 5_000),
      uplights_4: gear("uplights_4", "Uplights (pack of 4)", 12_000),
      fog_machine: gear("fog_machine", "Fog machine", 9_000, "exempt"),
    },
    addons: [
      { gear_key: "uplights_4", recommended_quantity: 1, max_quantity: 4 },
      { gear_key: "additional_location_speaker", recommended_quantity: 0, max_quantity: 3 },
      { gear_key: "wireless_mic", recommended_quantity: 0, max_quantity: 3 },
    ],
    questions: [
      question("ceremony_location", "single_choice", true, ["no_ceremony", "same_room", "separate_space"]),
      question("cocktail_location", "single_choice", true, ["same_room", "separate_space"]),
      question("speeches_wireless_mic", "boolean", true),
      question("effects", "multi_choice", false, ["fog", "bubbles"]),
      question("venue_notes", "short_text", false),
    ],
    rules: [
      rule("ceremony_location", { op: "equals", value: "separate_space" }, "additional_location_speaker", 1, "Separate ceremony space needs its own speaker."),
      rule("cocktail_location", { op: "equals", value: "separate_space" }, "additional_location_speaker", 1, "Separate cocktail space needs its own speaker."),
      rule("speeches_wireless_mic", { op: "equals", value: true }, "wireless_mic", 1, "Speeches need a wireless microphone."),
      rule("effects", { op: "contains", value: "fog" }, "fog_machine", 1, "Fog effects need a fog machine."),
    ],
  };
}

function gear(key: string, name: string, price: number, taxCategory = "standard") {
  return { key, name, description: null, unit_label: "unit", unit_price_cents: price, tax_category: taxCategory, media: [] };
}

function question(
  key: string,
  answer_type: "boolean" | "single_choice" | "multi_choice" | "short_text",
  required: boolean,
  options: string[] = [],
) {
  return { key, prompt: `${key}?`, answer_type, required, options: options.map((value) => ({ value, label: value })) };
}

function rule(
  question_key: string,
  condition: OfferSnapshot["rules"][number]["condition"],
  gear_key: string,
  required_quantity: number,
  reason: string,
) {
  return { question_key, condition, gear_key, required_quantity, reason };
}

/** Answers that trigger no rules. */
export const baseAnswers = {
  ceremony_location: "same_room",
  cocktail_location: "same_room",
  speeches_wireless_mic: false,
};
