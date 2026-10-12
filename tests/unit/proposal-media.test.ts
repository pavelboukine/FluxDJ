import { describe, expect, it } from "vitest";
import {
  IMAGE_WIDTHS,
  leadMediaIndex,
  mediaPath,
  mediaSrcSet,
  offerMedia,
  offerPackageMedia,
  packageLeadMedia,
  packageMediaPath,
  packageMediaSrcSet,
  parseMediaRequest,
  parsePackageMediaRequest,
  type MediaItem,
} from "@/lib/proposals/media";
import { parseOfferSnapshot, type OfferSnapshot } from "@/lib/pricing";
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

describe("package photos", () => {
  const photo = { storage_path: "t/packages/p/1.webp", content_type: "image/webp" as const, alt_text: "Full setup" };
  function withPackagePhoto(): { offer: OfferSnapshot; key: string } {
    const offer = demoOffer();
    offer.packages[1] = { ...offer.packages[1], image: photo };
    return { offer, key: offer.packages[1].key };
  }

  it("parses snapshots with and without a package photo, and rejects malformed ones", () => {
    const { offer, key } = withPackagePhoto();
    expect(parseOfferSnapshot(JSON.parse(JSON.stringify(offer))).packages.find((p) => p.key === key)?.image).toEqual(photo);
    expect(parseOfferSnapshot(JSON.parse(JSON.stringify(demoOffer()))).packages.every((p) => p.image === undefined)).toBe(true);
    const video = JSON.parse(JSON.stringify(offer));
    video.packages[1].image.content_type = "video/mp4";
    expect(() => parseOfferSnapshot(video)).toThrow();
    const extra = JSON.parse(JSON.stringify(offer));
    extra.packages[1].image.kind = "image";
    expect(() => parseOfferSnapshot(extra)).toThrow();
  });

  it("resolves a package's frozen photo by key only", () => {
    const { offer, key } = withPackagePhoto();
    expect(offerPackageMedia(offer, key)).toEqual({ kind: "image", ...photo });
    expect(offerPackageMedia(offer, offer.packages[0].key)).toBeNull();
    expect(offerPackageMedia(offer, "not_in_offer")).toBeNull();
    expect(offerPackageMedia(demoOffer(), key)).toBeNull();
  });

  it("is addressed on the sibling package-media route, with fixed widths", () => {
    expect(packageMediaPath("/dj/proposals/p/media", "signature", 400)).toBe("/dj/proposals/p/package-media/signature?w=400");
    expect(packageMediaPath("/staff/dj/proposals/p/media", "signature")).toBe("/staff/dj/proposals/p/package-media/signature");
    expect(packageMediaSrcSet("/b/media", "k")).toBe("/b/package-media/k?w=400 400w, /b/package-media/k?w=800 800w, /b/package-media/k?w=1200 1200w, /b/package-media/k?w=1600 1600w");
    expect(parsePackageMediaRequest("signature", null)).toEqual({ packageKey: "signature", width: 800 });
    for (const [key, w] of [["../x", null], ["Signature", null], ["signature", "799"], ["signature", ""], ["", null]] as const) {
      expect(parsePackageMediaRequest(key, w)).toBeNull();
    }
  });
});
