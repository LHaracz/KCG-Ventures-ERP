"use client";

import Link from "next/link";

export default function InvalidLinkPage() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center text-black shadow-sm" data-testid="invalid-link">
      <h1 className="text-lg font-semibold text-black">This invite link isn&apos;t valid anymore</h1>
      <p className="mt-2 text-sm text-black">This invite link isn&apos;t valid anymore. Ask an admin to send a new one.</p>
      <p className="mt-2 text-sm text-black">If you were resetting your password, request a new reset link.</p>
      <div className="mt-4 flex justify-center gap-3">
        <Link href="/forgot-password" className="text-sm font-medium text-emerald-700 underline">
          Reset password
        </Link>
        <Link href="/login" className="text-sm font-medium text-emerald-700 underline">
          Sign in
        </Link>
      </div>
    </div>
  );
}
