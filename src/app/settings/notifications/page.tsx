"use client";

import { FormEvent, useEffect, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";

const CONFIG_ID = "a0000000-0000-0000-0000-000000000001";
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_PRODUCTION_HOURS = "8,12,16,20";
const DEFAULT_LOW_STOCK_HOUR = 7;

export default function NotificationSettingsPage() {
  const { user, supabase } = useSupabase();
  const [emails, setEmails] = useState("");
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [productionHours, setProductionHours] = useState(DEFAULT_PRODUCTION_HOURS);
  const [lowStockHour, setLowStockHour] = useState(DEFAULT_LOW_STOCK_HOUR);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("notification_config")
        .select("recipient_emails, timezone, production_reminder_hours, low_stock_digest_hour")
        .eq("id", CONFIG_ID)
        .maybeSingle();
      if (!error && data) {
        setEmails((data.recipient_emails as string) ?? "");
        setTimezone((data.timezone as string) ?? DEFAULT_TIMEZONE);
        setProductionHours((data.production_reminder_hours as string) ?? DEFAULT_PRODUCTION_HOURS);
        setLowStockHour(Number(data.low_stock_digest_hour) ?? DEFAULT_LOW_STOCK_HOUR);
      }
      setLoading(false);
    };
    load();
  }, [user, supabase]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("notification_config")
        .upsert(
          {
            id: CONFIG_ID,
            recipient_emails: emails.trim(),
            timezone: timezone.trim() || DEFAULT_TIMEZONE,
            production_reminder_hours: productionHours.trim() || DEFAULT_PRODUCTION_HOURS,
            low_stock_digest_hour: lowStockHour >= 0 && lowStockHour <= 23 ? lowStockHour : DEFAULT_LOW_STOCK_HOUR,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "id" }
        );
      if (error) throw error;
      setMessage({ type: "ok", text: "Settings saved. All recipients will receive the same combined email (low stock + production by account)." });
    } catch (err: unknown) {
      const text = err instanceof Error ? err.message : "Failed to save";
      setMessage({ type: "error", text });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
            Notification Settings
          </h1>
          <p className="text-sm text-zinc-600">
            One combined email is sent to all recipients: low-stock digest (once per day) and production agenda by account (at 8 AM, 12 PM, 4 PM, 8 PM in your timezone).
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-black">Loading…</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 rounded-md border border-zinc-200 bg-white p-4 text-xs">
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Recipient email addresses (comma-separated)
              </label>
              <textarea
                rows={3}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                placeholder="one@example.com, another@example.com"
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <p className="mt-1 text-[11px] text-zinc-600">
                Everyone in this list receives the same combined email (low stock + production by account).
              </p>
            </div>
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Timezone
              </label>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/New_York"
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <p className="mt-1 text-[11px] text-zinc-600">
                Used for production reminder times (e.g. America/New_York).
              </p>
            </div>
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Production reminder hours (comma-separated, 0–23)
              </label>
              <input
                type="text"
                value={productionHours}
                onChange={(e) => setProductionHours(e.target.value)}
                placeholder="8,12,16,20"
                className="w-full rounded-md border border-zinc-300 px-2 py-1.5 text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="mb-1 block font-medium text-zinc-800">
                Low-stock digest hour (0–23, e.g. 7 for 7 AM)
              </label>
              <input
                type="number"
                min={0}
                max={23}
                value={lowStockHour}
                onChange={(e) => setLowStockHour(e.target.value === "" ? 0 : parseInt(e.target.value, 10))}
                className="w-20 rounded-md border border-zinc-300 px-2 py-1.5 text-black shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            {message && (
              <p className={message.type === "ok" ? "text-sm text-green-700" : "text-sm text-red-600"} role="alert">
                {message.text}
              </p>
            )}
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </form>
        )}
      </div>
    </AuthGuard>
  );
}
