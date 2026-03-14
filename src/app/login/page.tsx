"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSupabase } from "@/components/InstantProvider";

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoading, supabase } = useSupabase();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isLoading && user) {
    router.replace("/");
  }

  const handleSignInWithGoogle = async () => {
    setLoading(true);
    setError(null);
    try {
      // Prefer current origin so OAuth always redirects back to where the user is (Vercel or localhost).
      const redirectTo =
        (typeof window !== "undefined" ? `${window.location.origin}/` : null) ||
        process.env.NEXT_PUBLIC_FRONTEND_URL ||
        undefined;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
        },
      });
      if (error) {
        setError(error.message);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to start Google sign-in.");
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
        Sign in securely with your Google account via Supabase.
      </p>

      <div className="space-y-4">
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={loading}
          className="inline-flex w-full items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-70"
          onClick={handleSignInWithGoogle}
        >
          {loading ? "Redirecting…" : "Continue with Google"}
        </button>
      </div>
    </div>
  );
}


