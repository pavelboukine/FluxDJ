import { describe, expect, it } from "vitest";
import { normalizeSelectionDraft, recommendedSelection } from "@/lib/pricing";
import { renderEmail } from "@/lib/email/templates";
import { demoOffer } from "./fixtures/offer";

describe("normalizeSelectionDraft (autosave)", () => {
  it("accepts an incomplete selection and keeps only real choices", () => {
    const result = normalizeSelectionDraft(demoOffer(), {
      package_key: "signature",
      addons: { uplights_4: 2, wireless_mic: 0 },
      answers: { ceremony_location: "separate_space", venue_notes: "  " },
    });
    expect(result).toEqual({
      ok: true,
      draft: { package_key: "signature", addon_quantities: { uplights_4: 2 }, logistics_answers: { ceremony_location: "separate_space" } },
    });
  });

  it("rejects choices the offer does not allow", () => {
    const result = normalizeSelectionDraft(demoOffer(), {
      package_key: "platinum",
      addons: { uplights_4: 9, laser: 1 },
      answers: { ceremony_location: "rooftop", unknown: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code).sort()).toEqual(
        ["addon_not_offered", "addon_quantity_invalid", "answer_invalid", "answer_unknown_question", "package_not_offered"].sort(),
      );
    }
  });

  it("rejects prices or totals smuggled into a draft", () => {
    expect(normalizeSelectionDraft(demoOffer(), { package_key: "signature", total_cents: 1 }).ok).toBe(false);
  });

  it("starts from the DJ's recommended package and preselected addons", () => {
    expect(recommendedSelection(demoOffer())).toEqual({ package_key: "signature", addons: { uplights_4: 1, additional_location_speaker: 0, wireless_mic: 0 }, answers: {} });
  });
});

describe("email templates", () => {
  const base = { tenantDisplayName: "BOUPROD", tenantSlug: "bouprod", proposalId: "p1", appUrl: "http://127.0.0.1:3000" };

  it("puts the private link only in the proposal email", () => {
    const email = renderEmail({ ...base, eventType: "proposal_sent", payload: { event_title: "Gala", client_name: "Robin", expires_at: "2027-01-15T12:00:00Z" }, proposalLink: "http://127.0.0.1:3000/bouprod/p#TOKEN" });
    expect(email.subject).toBe("BOUPROD sent you a proposal for Gala");
    expect(email.text).toContain("http://127.0.0.1:3000/bouprod/p#TOKEN");
    expect(email.text).toContain("January 15, 2027");
    expect(() => renderEmail({ ...base, eventType: "proposal_sent", payload: {} })).toThrow();
  });

  it("labels a link opening as best effort, not proof of reading", () => {
    const email = renderEmail({ ...base, eventType: "proposal_link_opened", payload: { event_title: "Gala", opened_at: "2027-01-01T12:00:00Z" } });
    expect(email.text).toContain("does not prove the client has read the proposal");
    expect(email.text).not.toContain("#");
  });

  it("tells the client the contract follows and that it is not a booking yet", () => {
    const email = renderEmail({ ...base, eventType: "proposal_approved", payload: { event_title: "Gala", client_name: "Robin" } });
    expect(email.text).toContain("Your contract will follow");
    expect(email.text).toContain("not confirmed until the contract is completed");
    expect(email.text).not.toMatch(/you('| a)re booked|booking is confirmed/i);
  });

  it("escapes HTML from business data", () => {
    const email = renderEmail({ ...base, tenantDisplayName: "<b>DJ</b>", eventType: "proposal_approved", payload: { event_title: "<script>x</script>" } });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
