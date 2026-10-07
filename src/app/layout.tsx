import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { InstallPromptCapture, OfflineNotice } from "@/components/app/pwa";

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
  // Home-screen app (see app/manifest.ts). iOS reads its title and status bar from these.
  applicationName: "Flux DJ",
  appleWebApp: { capable: true, title: "Flux DJ", statusBarStyle: "default" },
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
