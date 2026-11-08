"use client";

import { useEffect } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

/** Signed in, but not an active employee: show the message, grant nothing, and sign out. */
export default function NoAccessPage() {
  useEffect(() => {
    supabase.auth.signOut().catch(() => {});
  }, []);
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center text-black shadow-sm" data-testid="no-access">
      <h1 className="text-lg font-semibold text-black">You don&apos;t have access to this ERP. Contact an admin.</h1>
      <p className="mt-2 text-sm text-black">You have been signed out.</p>
      <Link href="/login" className="mt-4 inline-block text-sm font-medium text-emerald-700 underline">
        Back to sign in
      </Link>
    </div>
  );
}
