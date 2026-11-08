"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/accept-invite?flow=recovery`,
    });
    setSending(false);
    // Same message whether or not the address has an account.
    if (error && !/rate|limit/i.test(error.message)) setError(error.message);
    else if (error) setError("Too many requests. Wait a minute and try again.");
    else setSent(true);
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center text-black">
      <h1 className="mb-2 text-xl font-semibold text-black">Reset your password</h1>
      {sent ? (
        <p className="text-sm text-black" role="status">
          If that address has an account, we sent it a link to set a new password. The link works once.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-black">Enter the email you sign in with. We&apos;ll email you a link to set a new password.</p>
          <div>
            <label htmlFor="reset-email" className="mb-1 block text-sm font-medium text-black">
              Email
            </label>
            <input
              id="reset-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black"
            />
          </div>
          {error && (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={sending} className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
            {sending ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}
      <Link href="/login" className="mt-4 text-sm font-medium text-emerald-700 underline">
        Back to sign in
      </Link>
    </div>
  );
}
