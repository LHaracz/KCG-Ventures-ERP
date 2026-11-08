"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useSupabase } from "@/components/InstantProvider";

export default function LoginPage() {
  const { user, isLoading, supabase } = useSupabase();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where to go after signing in (only paths inside this app).
  const nextPath = () => {
    if (typeof window === "undefined") return "/";
    const n = new URLSearchParams(window.location.search).get("next") ?? "/";
    return n.startsWith("/") && !n.startsWith("//") ? n : "/";
  };

  // Already signed in: a full page load, so the server sees the session cookie.
  useEffect(() => {
    if (!isLoading && user) window.location.replace(nextPath());
  }, [isLoading, user]);

  const handlePasswordLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setError(error.message);
      } else {
        window.location.replace(nextPath());
      }
    } catch (err: any) {
      setError(err?.message || "Failed to sign in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <h1 className="mb-2 text-xl font-semibold text-black">
        Log in to KCG Ventures ERP
      </h1>
      <p className="mb-6 text-sm text-black">
        Sign in with an account that has been set up for you. New accounts can
        only be created by an administrator.
      </p>

      <form onSubmit={handlePasswordLogin} className="space-y-4">
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-medium text-black">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="login-password" className="block text-sm font-medium text-black">
              Password
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-emerald-700 underline">
              Forgot password?
            </Link>
          </div>
          <input
            id="login-password"
            type="password"
            required
            autoComplete="current-password"
            className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-black placeholder:text-gray-400 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:text-gray-500"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="inline-flex w-full items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? "Signing in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

