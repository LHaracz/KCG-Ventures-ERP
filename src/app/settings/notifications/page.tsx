"use client";

import { useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";

export default function NotificationSettingsPage() {
  const [emails, setEmails] = useState<string>("");
  const [enabled, setEnabled] = useState(false);

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Notification Settings
          </h1>
          <p className="text-sm text-zinc-600">
            Configure future email reminders for tray runs and cycle events.
            This is configuration only; email sending will be added in a later
            phase.
          </p>
        </header>

        <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs">
          <div className="mb-4">
            <label className="mb-1 block font-medium text-zinc-800">
              Recipient email addresses
            </label>
            <textarea
              rows={3}
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="one@example.com, another@example.com"
              className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-xs shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-[11px] text-black">
              Enter a comma-separated list of addresses to receive future
              reminders.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
            />
            <label
              htmlFor="enabled"
              className="text-xs font-medium text-zinc-800"
            >
              Enable email reminders (future feature)
            </label>
          </div>
          <p className="mt-3 text-[11px] text-black">
            These settings are UI-only for now. In a future phase, they will be
            wired to background jobs that send actual reminder emails.
          </p>
        </section>
      </div>
    </AuthGuard>
  );
}

