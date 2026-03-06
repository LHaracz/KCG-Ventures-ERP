import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navigation } from "@/components/Navigation";
import { SupabaseProvider } from "@/components/InstantProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KCG Ventures ERP",
  description: "Production planning and costing ERP for BotanIQals + MiniLeaf",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <SupabaseProvider>
          <div className="min-h-screen flex flex-col">
            <Navigation />
            <main className="flex-1 bg-zinc-50 px-4 py-6 sm:px-6 lg:px-8">
              {children}
            </main>
          </div>
        </SupabaseProvider>
      </body>
    </html>
  );
}

