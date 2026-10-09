import type { NextConfig } from "next";

// Client proposal pages carry bearer access: never cache, index, frame, or
// leak their URLs through the Referer header.
const privatePageHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Frame-Options", value: "DENY" },
];

// Client contract pages: private like proposals, but "strict-origin" because
// they submit forms ("no-referrer" makes native form POSTs send Origin: null).
const clientFormPageHeaders = [
  { key: "Referrer-Policy", value: "strict-origin" },
  { key: "Cache-Control", value: "private, no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  // Local URLs use 127.0.0.1 (it must match the magic-link site URL). Without
  // this, a dev server started as plain `next dev` (localhost) blocks its own
  // scripts and HMR for 127.0.0.1 pages. Development only.
  allowedDevOrigins: ["127.0.0.1"],
  // Logo uploads (Settings, Branding) send the image to a Server Action, which
  // verifies and re-encodes it. Files are limited to 4 MB; this leaves room for
  // the form around it and stays under Vercel's 4.5 MB request limit.
  experimental: {
    serverActions: { bodySizeLimit: "4.5mb" },
  },
  // Signed-contract PDFs render with bundled fonts read from disk at runtime;
  // trace them into every server function (they are small and never fetched).
  outputFileTracingIncludes: {
    "/*": ["./assets/fonts/**/*"],
  },
  async headers() {
    return [
      { source: "/:tenant/p", headers: privatePageHeaders },
      { source: "/:tenant/p/exchange", headers: privatePageHeaders },
      { source: "/:tenant/proposals/:proposalId", headers: privatePageHeaders },
      // Proposal photos: private like the page, but the media route sets its own
      // Cache-Control (private, one hour, then revalidated with an access check).
      { source: "/:tenant/proposals/:proposalId/media/:path*", headers: privatePageHeaders.filter((h) => h.key !== "Cache-Control") },
      { source: "/:tenant/invite", headers: clientFormPageHeaders },
      { source: "/:tenant/invitations/:path*", headers: clientFormPageHeaders },
      { source: "/:tenant/contracts/:path*", headers: clientFormPageHeaders },
      { source: "/:tenant/planning/:path*", headers: clientFormPageHeaders },
      { source: "/my", headers: clientFormPageHeaders },
      // The home-screen app's start URL: a per-session redirect with no content. Next.js sends its
      // own "no-cache, must-revalidate" on redirects (as for /my and /staff); this applies otherwise.
      { source: "/start", headers: [{ key: "Cache-Control", value: "private, no-store" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      { source: "/staff/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "same-origin" }] },
    ];
  },
};

export default nextConfig;
