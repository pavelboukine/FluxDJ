import type { OfferSnapshot } from "./offer-snapshot";
import type { AnswerValue } from "./price-selection";

/** The client's editable choices (prices always come from the frozen offer). */
export type ProposalSelectionState = {
  package_key: string;
  addons: Record<string, number>;
  answers: Record<string, AnswerValue>;
};

/** The DJ's recommended starting point: the most popular package and preselected addons. */
export function recommendedSelection(offer: OfferSnapshot): ProposalSelectionState {
  const popular = offer.packages.find((p) => p.is_popular) ?? offer.packages[0];
  return {
    package_key: popular.key,
    addons: Object.fromEntries(offer.addons.map((a) => [a.gear_key, a.recommended_quantity])),
    answers: {},
  };
}
