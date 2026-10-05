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
  // Signed-contract PDFs render with bundled fonts read from disk at runtime;
  // trace them into every server function (they are small and never fetched).
  outputFileTracingIncludes: {
    "/*": ["./assets/fonts/**/*"],
  },
  async headers() {
    return [
      { source: "/:tenant/p", headers: privatePageHeaders },
      { source: "/:tenant/p/exchange", headers: privatePageHeaders },
      { source: "/:tenant/proposals/:path*", headers: privatePageHeaders },
      { source: "/:tenant/invite", headers: clientFormPageHeaders },
      { source: "/:tenant/invitations/:path*", headers: clientFormPageHeaders },
      { source: "/:tenant/contracts/:path*", headers: clientFormPageHeaders },
      { source: "/my", headers: clientFormPageHeaders },
      { source: "/staff/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "same-origin" }] },
    ];
  },
};

export default nextConfig;
