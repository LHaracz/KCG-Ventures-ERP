"use client";

import { FormEvent, useState } from "react";
import { checkPassword } from "@/lib/access/passwordPolicy";
import { supabase } from "@/lib/supabaseClient";

/** New-password form with the live policy checklist. Saves through the server, which checks the policy again. */
export function SetPasswordForm({
  title,
  intro,
  submitLabel = "Save password",
  onDone,
}: {
  title: string;
  intro?: string;
  submitLabel?: string;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checks = checkPassword(password);
  const allOk = checks.every((c) => c.ok);
  const matches = password.length > 0 && password === confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allOk || !matches) return;
    setSaving(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch("/api/account/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}` },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't save the password.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4 text-black" data-testid="set-password-form">
      <div>
        <h1 className="text-xl font-semibold text-black">{title}</h1>
        {intro && <p className="mt-1 text-sm text-black">{intro}</p>}
      </div>
      <div>
        <label htmlFor="new-password" className="mb-1 block text-sm font-medium text-black">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black"
        />
      </div>
      <ul className="space-y-1 text-sm" aria-label="Password requirements" data-testid="password-checklist">
        {checks.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-black" data-ok={c.ok}>
            <span aria-hidden className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${c.ok ? "bg-emerald-200" : "bg-zinc-200"}`}>
              {c.ok ? "✓" : ""}
            </span>
            {c.label}
            <span className="sr-only">{c.ok ? "(met)" : "(not met)"}</span>
          </li>
        ))}
      </ul>
      <div>
        <label htmlFor="confirm-password" className="mb-1 block text-sm font-medium text-black">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-black"
        />
        {confirm.length > 0 && !matches && <p className="mt-1 text-xs text-red-700">The passwords don&apos;t match.</p>}
      </div>
      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!allOk || !matches || saving}
        className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {saving ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
