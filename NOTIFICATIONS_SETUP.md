# Notifications setup

## 1. Database (Supabase)

Run the SQL in **Supabase → SQL Editor** from the file `supabase-notification-tables.sql`. This creates:

- `notification_config` – single row for recipient emails, timezone, and reminder hours
- `notifications` – in-app notification rows (per user)

## 2. Environment variables

For **local** or **Vercel**, add:

| Variable | Description |
|----------|-------------|
| `CRON_SECRET` | Secret string; Vercel Cron (or your scheduler) must send this in the `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret` header when calling `/api/cron/notifications`. |
| `RESEND_API_KEY` | API key from [Resend](https://resend.com) for sending email. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project **service role** key (Project Settings → API), so the cron can read config and insert notifications. |
| `NEXT_PUBLIC_SUPABASE_URL` | (Optional) Your Supabase URL if different from the one in code. |
| `RESEND_FROM` | (Optional) From address for email (e.g. `notifications@yourdomain.com`). Defaults to `notifications@resend.dev` if unset. |

## 3. Vercel Cron

The repo includes `vercel.json` with an hourly cron that calls `/api/cron/notifications`. In **Vercel → Project → Settings → Environment Variables**, set `CRON_SECRET` and add the same value in **Vercel → Cron Jobs** (or the cron request is sent with the header automatically; confirm in Vercel docs). The route accepts the secret via `Authorization: Bearer <CRON_SECRET>`, header `x-cron-secret`, or query `?cron_secret=<CRON_SECRET>`. Vercel Cron does not add custom headers, so you can use an external cron (e.g. cron-job.org) that calls `https://your-app.vercel.app/api/cron/notifications?cron_secret=YOUR_CRON_SECRET` hourly, or use Vercel’s cron and protect the URL by keeping the secret private.

## 4. App usage

- **Notification settings** (nav: “Notification settings”): set recipient emails (comma-separated), timezone (e.g. `America/New_York`), production reminder hours (e.g. `8,12,16,20`), and low-stock digest hour (e.g. `7` for 7 AM). Everyone in the list receives the **same** combined email.
- **Alerts** (nav: “Alerts”): in-app list of notifications (low-stock digest and production reminders); mark as read.

One email per run contains (when applicable): **Section 1** – low-stock items (QOH ≤ par); **Section 2** – today’s production agenda, split by account.
