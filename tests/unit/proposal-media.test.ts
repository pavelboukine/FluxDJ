import { describe, expect, it } from "vitest";
import { IMAGE_WIDTHS, leadMediaIndex, mediaPath, mediaSrcSet, offerMedia, packageLeadMedia, parseMediaRequest, type MediaItem } from "@/lib/proposals/media";
import type { OfferSnapshot } from "@/lib/pricing";
import { demoOffer } from "./fixtures/offer";

const image = (n: number): MediaItem => ({ storage_path: `t/gear-items/g/${n}.jpg`, kind: "image", content_type: "image/jpeg", alt_text: `Photo ${n}` });
const video = (n: number): MediaItem => ({ storage_path: `t/gear-items/g/${n}.mp4`, kind: "video", content_type: "video/mp4", alt_text: `Video ${n}` });

function withMedia(media: Record<string, MediaItem[]>): OfferSnapshot {
  const offer = demoOffer();
  for (const [key, items] of Object.entries(media)) offer.gear[key] = { ...offer.gear[key], media: items };
  return offer;
}

describe("media request parsing", () => {
  it("accepts offer positions and the fixed widths only", () => {
    expect(parseMediaRequest("uplights_4", "0", null)).toEqual({ gearKey: "uplights_4", index: 0, width: 800 });
    for (const w of IMAGE_WIDTHS) expect(parseMediaRequest("uplights_4", "12", String(w))?.width).toBe(w);
  });

  it("rejects paths, URLs, odd indexes and arbitrary sizes", () => {
    for (const [key, index, w] of [
      ["../secret", "0", null],
      ["Uplights", "0", null],
      ["uplights_4", "-1", null],
      ["uplights_4", "01", null],
      ["uplights_4", "100", null],
      ["uplights_4", "1.5", null],
      ["uplights_4", "https://example.com/x.jpg", null],
      ["uplights_4", "0", "5000"],
      ["uplights_4", "0", "799"],
      ["uplights_4", "0", ""],
    ] as const) {
      expect(parseMediaRequest(key, index, w)).toBeNull();
    }
  });

  it("builds same-origin URLs with every width in srcset", () => {
    expect(mediaPath("/dj/proposals/p/media", "uplights_4", 2, 400)).toBe("/dj/proposals/p/media/uplights_4/2?w=400");
    expect(mediaSrcSet("/b", "k", 0)).toBe("/b/k/0?w=400 400w, /b/k/0?w=800 800w, /b/k/0?w=1200 1200w, /b/k/0?w=1600 1600w");
  });
});

describe("resolving media from the frozen offer", () => {
  it("resolves only items the offer has", () => {
    const offer = withMedia({ uplights_4: [image(1)] });
    expect(offer.gear.uplights_4).toBeDefined();
    expect(offerMedia(offer, "uplights_4", 0)?.storage_path).toBe("t/gear-items/g/1.jpg");
    expect(offerMedia(offer, "uplights_4", 1)).toBeNull();
    expect(offerMedia(offer, "not_in_offer", 0)).toBeNull();
    expect(offerMedia(offer, "constructor", 0)).toBeNull();
  });
});

describe("lead photos", () => {
  it("is the first photo in frozen order, else the first video", () => {
    expect(leadMediaIndex([video(1), image(2), image(3)])).toBe(1);
    expect(leadMediaIndex([video(1)])).toBe(0);
    expect(leadMediaIndex([])).toBe(-1);
  });

  it("for a package, is the first included item (in package order) that has a photo", () => {
    const offer = demoOffer();
    const pkg = offer.packages.find((p) => p.included.length >= 2)!;
    const [first, second] = pkg.included.map((i) => i.gear_key);
    const noPhoto = withMedia({ [first]: [video(1)], [second]: [video(2), image(3)] });
    expect(packageLeadMedia(noPhoto, pkg.key)).toEqual({ gearKey: second, index: 1 });
    const firstHasPhoto = withMedia({ [first]: [image(4)], [second]: [image(5)] });
    expect(packageLeadMedia(firstHasPhoto, pkg.key)).toEqual({ gearKey: first, index: 0 });
    expect(packageLeadMedia(demoOffer(), pkg.key)).toBeNull();
  });
});
