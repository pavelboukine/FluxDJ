import type { MetadataRoute } from "next";

/**
 * One shared installation identity for every business and client (V1).
 * Tenant pages keep their DJ's branding inside the app. Nothing here is
 * personal or tenant-specific: the start URL is the neutral /start route,
 * which sends each person to their own place after checking the session.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/start",
    name: "Flux DJ",
    short_name: "Flux DJ",
    description: "Proposals, contracts and event planning with your DJ.",
    start_url: "/start",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
