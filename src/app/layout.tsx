import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Navigation } from "@/components/Navigation";
import { SupabaseProvider } from "@/components/InstantProvider";
import { AccessProvider, type Me } from "@/components/access/AccessProvider";
import { getAccess } from "@/lib/access/server";
import { buildSidebar } from "@/lib/access/catalog";

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

// The first sidebar comes from the server (no flash of other features); the
// browser refreshes it from /api/account/me on each navigation.
async function initialAccess(): Promise<Me | null> {
  const { access } = await getAccess();
  if (!access?.active) return null;
  return {
    active: access.active,
    status: access.status,
    isAdmin: access.isAdmin,
    features: Array.from(access.features).sort(),
    roles: access.roles,
    firstName: access.firstName,
    lastName: access.lastName,
    fullName: access.fullName,
    accountId: access.accountId,
    sidebar: buildSidebar(access),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const initial = await initialAccess();
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <SupabaseProvider>
          <AccessProvider initial={initial}>
            <div className="min-h-screen md:flex">
              <Navigation />
              <main className="flex-1 bg-zinc-50 px-4 py-6 sm:px-6 lg:px-8">
                {children}
              </main>
            </div>
          </AccessProvider>
        </SupabaseProvider>
      </body>
    </html>
  );
}
