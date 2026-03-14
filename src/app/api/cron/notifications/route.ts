import { NextResponse } from "next/server";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { format } from "date-fns";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendNotificationEmail } from "@/lib/sendNotificationEmail";

const CONFIG_ID = "a0000000-0000-0000-0000-000000000001";

function getCurrentHourInTimezone(timezone: string): number {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  return zoned.getHours();
}

function getTodayStartEndUtc(timezone: string): { start: string; end: string } {
  const now = new Date();
  const zoned = toZonedTime(now, timezone);
  const y = zoned.getFullYear();
  const m = zoned.getMonth();
  const d = zoned.getDate();
  const startOfDay = fromZonedTime(new Date(y, m, d, 0, 0, 0, 0), timezone);
  const endOfDay = fromZonedTime(new Date(y, m, d, 23, 59, 59, 999), timezone);
  return {
    start: startOfDay.toISOString(),
    end: endOfDay.toISOString(),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const secret =
    request.headers.get("authorization")?.replace("Bearer ", "") ??
    request.headers.get("x-cron-secret") ??
    url.searchParams.get("cron_secret") ??
    "";
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin;
  if (!admin) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const { data: configRow, error: configErr } = await admin
    .from("notification_config")
    .select("recipient_emails, timezone, production_reminder_hours, low_stock_digest_hour")
    .eq("id", CONFIG_ID)
    .maybeSingle();

  if (configErr || !configRow) {
    return NextResponse.json({ error: "Notification config not found", detail: configErr?.message }, { status: 502 });
  }

  const timezone = (configRow.timezone as string) || "America/New_York";
  const lowStockHour = Number(configRow.low_stock_digest_hour) ?? 7;
  const productionHoursStr = (configRow.production_reminder_hours as string) || "8,12,16,20";
  const productionHours = productionHoursStr.split(",").map((h) => parseInt(h.trim(), 10)).filter((n) => !Number.isNaN(n));
  const recipientEmails = (configRow.recipient_emails as string)
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipientEmails.length === 0) {
    return NextResponse.json({ ok: true, message: "No recipients configured" });
  }

  const currentHour = getCurrentHourInTimezone(timezone);
  const sections: string[] = [];
  let title = "KCG Ventures ERP – Notification";

  // Section 1: Low-stock digest (when current hour matches)
  if (currentHour === lowStockHour) {
    const { data: lowItems } = await admin
      .from("inventory_items")
      .select("id, name, unit, quantity_on_hand, par_level")
      .not("par_level", "is", null);

    const atOrBelowPar = (lowItems || []).filter(
      (row: { quantity_on_hand: number; par_level: number | null }) =>
        row.par_level != null && Number(row.quantity_on_hand) <= Number(row.par_level)
    );
    if (atOrBelowPar.length > 0) {
      const lines = atOrBelowPar.map(
        (r: { name: string; quantity_on_hand: number; par_level: number | null; unit: string }) =>
          `<tr><td>${escapeHtml(r.name)}</td><td>${r.quantity_on_hand} ${escapeHtml(r.unit)}</td><td>${r.par_level} ${escapeHtml(r.unit)}</td></tr>`
      );
      sections.push(
        `<h2>Low stock (at or below par)</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><thead><tr><th>Item</th><th>QOH</th><th>Par</th></tr></thead><tbody>${lines.join("")}</tbody></table>`
      );
      title = "KCG Ventures ERP – Low stock digest";
    }
  }

  // Section 2: Production by account (when current hour is 8, 12, 16, or 20)
  if (productionHours.includes(currentHour)) {
    const { start, end } = getTodayStartEndUtc(timezone);
    const { data: events } = await admin
      .from("schedule_events")
      .select("id, user_id, title, event_type, start_at, trays, quantity, quantity_unit, run_number, machine_number")
      .gte("start_at", start)
      .lte("start_at", end)
      .order("start_at", { ascending: true });

    const byUser = new Map<string, typeof events>();
    for (const ev of events || []) {
      const uid = (ev as { user_id: string }).user_id;
      if (!uid) continue;
      if (!byUser.has(uid)) byUser.set(uid, []);
      byUser.get(uid)!.push(ev);
    }

    if (byUser.size > 0) {
      const { data: usersData } = await admin.auth.admin.listUsers();
      const userEmails = new Map<string, string>();
      for (const u of usersData?.users ?? []) {
        if (u.email) userEmails.set(u.id, u.email);
      }

      const todayLabel = format(toZonedTime(new Date(), timezone), "EEEE, MMM d, yyyy");
      const parts: string[] = [`<h2>Production agenda – ${todayLabel}</h2>`];
      for (const [userId, userEvents] of byUser) {
        const email = userEmails.get(userId) ?? userId.slice(0, 8);
        parts.push(`<h3>Account (${escapeHtml(email)})</h3><ul>`);
        for (const ev of userEvents as Array<{ title: string; event_type: string; start_at: string; trays?: number; quantity?: number; quantity_unit?: string }>) {
          const time = ev.start_at ? format(new Date(ev.start_at), "h:mm a") : "";
          let line = escapeHtml(ev.title || ev.event_type || "Event");
          if (time) line = `[${time}] ${line}`;
          if (ev.trays != null) line += ` – ${ev.trays} trays`;
          if (ev.quantity != null && ev.quantity_unit) line += ` – ${ev.quantity} ${ev.quantity_unit}`;
          parts.push(`<li>${line}</li>`);
        }
        parts.push("</ul>");
      }
      sections.push(parts.join(""));
      if (sections.length === 1) title = "KCG Ventures ERP – Production reminder";
      else title = "KCG Ventures ERP – Digest & production reminder";
    }
  }

  if (sections.length === 0) {
    return NextResponse.json({ ok: true, message: "No content for this hour" });
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="font-family:sans-serif;max-width:640px">${sections.join("<hr/>")}</body></html>`;

  const { ok, error } = await sendNotificationEmail(recipientEmails, title, html);
  if (!ok) {
    return NextResponse.json({ error: "Failed to send email", detail: error }, { status: 500 });
  }

  // In-app: insert one notification per user so everyone sees the digest
  const body = sections.join("\n\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const { data: usersData } = await admin.auth.admin.listUsers();
  const userIds = usersData?.users?.map((u) => u.id) ?? [];
  for (const uid of userIds) {
    await admin.from("notifications").insert({
      user_id: uid,
      type: "combined_digest",
      title,
      body: body.slice(0, 10000),
    });
  }

  return NextResponse.json({ ok: true, recipients: recipientEmails.length });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
