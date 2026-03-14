"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoading, supabase } = useSupabase();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLoading && user) {
    router.replace("/");
  }

  const handlePasswordLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const email =
        process.env.NEXT_PUBLIC_AUTH_EMAIL || "owner@example.com";

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        setError(error.message);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to sign in.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center">
      <h1 className="mb-2 text-xl font-semibold text-zinc-900">
        Log in to KCG Ventures ERP
      </h1>
      <p className="mb-6 text-sm text-zinc-600">
        Enter your password to access the ERP.
      </p>

      <form onSubmit={handlePasswordLogin} className="space-y-4">
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <div>
          <label className="mb-1 block text-sm font-medium text-zinc-800">
            Password
          </label>
          <input
            type="password"
            required
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

