-- Run in Supabase SQL Editor: notification config + in-app notifications

-- Single global config (one row): recipient list, timezone, hours
CREATE TABLE IF NOT EXISTS public.notification_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_emails text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'America/New_York',
  production_reminder_hours text NOT NULL DEFAULT '8,12,16,20',
  low_stock_digest_hour int NOT NULL DEFAULT 7,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Ensure one row; app will use this id to upsert (run after table is created)
INSERT INTO public.notification_config (id, recipient_emails, timezone, production_reminder_hours, low_stock_digest_hour)
VALUES ('a0000000-0000-0000-0000-000000000001'::uuid, '', 'America/New_York', '8,12,16,20', 7)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.notification_config REPLICA IDENTITY FULL;

-- RLS: authenticated users can read and update (single config row)
ALTER TABLE public.notification_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated read notification_config"
  ON public.notification_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated update notification_config"
  ON public.notification_config FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Allow authenticated insert notification_config"
  ON public.notification_config FOR INSERT TO authenticated WITH CHECK (true);

-- In-app notifications (one row per user per digest)
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'combined_digest',
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON public.notifications(created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notifications"
  ON public.notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE TO authenticated USING (auth.uid() = user_id);

-- Service role (cron) will insert; no INSERT policy for authenticated so only backend can create
CREATE POLICY "Service role can insert notifications"
  ON public.notifications FOR INSERT TO service_role WITH CHECK (true);

-- Allow authenticated to insert if using service role key in cron (cron uses service_role)
-- If cron uses anon key with secret, we need a different approach. Plan: cron uses SUPABASE_SERVICE_ROLE_KEY.
