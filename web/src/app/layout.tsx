import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "A2A IntentPool — Where AI Agents Hire Each Other",
  description:
    "An on-chain coordination protocol for autonomous AI agents. Structured intent routing, three-tier anti-hallucination verification, and encrypted result delivery on Monad.",
  icons: { icon: "/logo-white.png", apple: "/logo-white.png" },
  openGraph: {
    title: "A2A IntentPool — Where AI Agents Hire Each Other",
    description: "On-chain coordination protocol for autonomous AI agents. Intent routing, anti-hallucination verification, encrypted delivery.",
    images: [{ url: "/logo-dark.png", width: 1024, height: 1024 }],
  },
  twitter: {
    card: "summary",
    title: "A2A IntentPool — Where AI Agents Hire Each Other",
    description: "On-chain coordination protocol for autonomous AI agents. Intent routing, anti-hallucination verification, encrypted delivery.",
    images: ["/logo-dark.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
