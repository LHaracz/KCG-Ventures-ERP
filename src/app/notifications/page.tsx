"use client";

import { useEffect, useState } from "react";
import { AuthGuard } from "@/components/AuthGuard";
import { useSupabase } from "@/components/InstantProvider";
import { formatDate } from "@/lib/date";

type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

export default function NotificationsPage() {
  const { user, supabase } = useSupabase();
  const [list, setList] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("notifications")
        .select("id, user_id, type, title, body, read_at, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (err) setError(err.message);
      else setList((data ?? []) as NotificationRow[]);
      setLoading(false);
    };
    load();
  }, [user, supabase]);

  const markRead = async (id: string) => {
    if (!user) return;
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);
    setList((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
  };

  const markAllRead = async () => {
    if (!user) return;
    const unread = list.filter((n) => !n.read_at);
    for (const n of unread) {
      await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", n.id)
        .eq("user_id", user.id);
    }
    setList((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() }))
    );
  };

  const unreadCount = list.filter((n) => !n.read_at).length;

  return (
    <AuthGuard>
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="mb-1 text-2xl font-semibold text-zinc-900">
              Notification center
            </h1>
            <p className="text-sm text-zinc-600">
              Low-stock digests and production reminders. Configure recipients and times in Notification settings.
            </p>
          </div>
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-300"
            >
              Mark all read
            </button>
          ) : null}
        </header>

        {loading ? (
          <p className="text-sm text-black">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600" role="alert">{error}</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-zinc-600">No notifications yet.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((n) => (
              <li
                key={n.id}
                className={`rounded-md border px-3 py-2 ${
                  n.read_at ? "border-zinc-100 bg-zinc-50" : "border-emerald-200 bg-emerald-50/50"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-zinc-900">{n.title}</div>
                    <div className="mt-0.5 text-[11px] text-zinc-600">
                      {formatDate(n.created_at)}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-zinc-700 line-clamp-4">
                      {n.body}
                    </div>
                  </div>
                  {!n.read_at && (
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      className="shrink-0 rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-700"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AuthGuard>
  );
}
