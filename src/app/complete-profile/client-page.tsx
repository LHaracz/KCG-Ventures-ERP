"use client";

import { FormEvent, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/** Required before anything else when an active account has no first or last name yet. */
export default function CompleteProfilePage() {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/account/complete-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
        body: JSON.stringify({ firstName: first, lastName: last }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && body.code !== "already_set") throw new Error(body.error || "Couldn't save your name.");
      window.location.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your name.");
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center text-black">
      <form onSubmit={submit} className="space-y-4" data-testid="complete-profile">
        <div>
          <h1 className="text-xl font-semibold text-black">Your name</h1>
          <p className="mt-1 text-sm text-black">Your name is recorded on the logs, reviews and documents you complete. Enter it once to continue.</p>
        </div>
        <div>
          <label htmlFor="first-name" className="mb-1 block text-sm font-medium text-black">First name</label>
          <input id="first-name" required value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black" />
        </div>
        <div>
          <label htmlFor="last-name" className="mb-1 block text-sm font-medium text-black">Last name</label>
          <input id="last-name" required value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black" />
        </div>
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        <button type="submit" disabled={saving || !first.trim() || !last.trim()}
          className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60">
          {saving ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
