import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { InstallPromptCapture, OfflineNotice } from "@/components/app/pwa";
import { STARTUP_IMAGES } from "@/lib/pwa-startup-images";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Flux DJ",
  description: "Proposals, contracts and event planning for independent DJs",
  // Home-screen app (see app/manifest.ts). iOS reads its title and status bar from these, and shows the
  // launch image for the screen (white with the Flux wordmark, as the app opens) instead of a blank screen.
  applicationName: "Flux DJ",
  appleWebApp: { capable: true, title: "Flux DJ", statusBarStyle: "default", startupImage: STARTUP_IMAGES },
  // Next.js writes the standard "mobile-web-app-capable"; launch images have needed Apple's own name.
  other: { "apple-mobile-web-app-capable": "yes" },
};

// Zoom stays available (no maximum scale). The default viewport fit keeps
// content inside the safe area around the notch and home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <InstallPromptCapture />
        <OfflineNotice />
      </body>
    </html>
  );
}
