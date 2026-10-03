import type { NextConfig } from "next";

// Client proposal pages carry bearer access: never cache, index, frame, or
// leak their URLs through the Referer header.
const privatePageHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:tenant/p", headers: privatePageHeaders },
      { source: "/:tenant/p/exchange", headers: privatePageHeaders },
      { source: "/:tenant/proposals/:path*", headers: privatePageHeaders },
      { source: "/staff/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "same-origin" }] },
    ];
  },
};

export default nextConfig;
