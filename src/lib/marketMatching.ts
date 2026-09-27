// Tags a POS order with the recurring farmers market it fell within, or
// "other" (informal/friend POS sales outside any scheduled market window).
// Pure functions — called both at import time (src/lib/salesImport.ts) and
// from the Markets page's "Recalculate Market Tags" action.
//
// Reuses this app's established timezone convention exactly: toZonedTime()
// + plain Date getters + date-fns format(), the same pattern used by
// getCurrentHourInTimezone()/toDateKeyInTimezone() in
// src/app/api/cron/notifications/route.ts. The timezone itself is read from
// notification_config.timezone (default "America/New_York") rather than
// introducing a third timezone setting.
import { toZonedTime } from "date-fns-tz";
import { format } from "date-fns";

export type MarketRow = {
  id: string;
  day_of_week: number; // 0=Sunday..6=Saturday, matches Date#getDay()
  start_time: string; // Postgres `time`, returned as "HH:MM:SS"
  end_time: string;
  season_start_date: string; // Postgres `date`, returned as "YYYY-MM-DD"
  season_end_date: string;
  active: boolean;
};

export type MarketMatchResult = {
  market_id: string | null;
  pos_category: "market" | "other" | null;
};

function parseTimeToMinutes(value: string): number {
  const [h, m] = value.split(":").map((part) => Number(part));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// If channel isn't a POS sale, market_id/pos_category both stay null (per
// spec). Otherwise: does the order's created_at (in local business time)
// fall on a matching day_of_week, within an active market's season and
// time-of-day window? Exactly one match -> that market, "market". No match
// -> null, "other" (an informal/friend POS sale outside any market). More
// than one match (overlapping windows, shouldn't normally happen) -> the
// first match, with a console.warn so it doesn't silently pick one.
export function matchMarketForOrder(
  createdAtIso: string,
  channel: string | null,
  markets: MarketRow[],
  timezone: string,
): MarketMatchResult {
  if (!channel || !channel.toLowerCase().includes("pos")) {
    return { market_id: null, pos_category: null };
  }

  const zoned = toZonedTime(new Date(createdAtIso), timezone);
  const dayOfWeek = zoned.getDay();
  const dateKey = format(zoned, "yyyy-MM-dd");
  const minutesOfDay = zoned.getHours() * 60 + zoned.getMinutes();

  const matches = markets.filter((market) => {
    if (!market.active) return false;
    if (market.day_of_week !== dayOfWeek) return false;
    if (dateKey < market.season_start_date || dateKey > market.season_end_date) return false;
    const startMinutes = parseTimeToMinutes(market.start_time);
    const endMinutes = parseTimeToMinutes(market.end_time);
    return minutesOfDay >= startMinutes && minutesOfDay <= endMinutes;
  });

  if (matches.length === 0) {
    return { market_id: null, pos_category: "other" };
  }
  if (matches.length > 1) {
    console.warn(
      `matchMarketForOrder: order created at ${createdAtIso} matched ${matches.length} ` +
        `overlapping active markets (${matches.map((m) => m.id).join(", ")}) — using the first.`,
    );
  }
  return { market_id: matches[0].id, pos_category: "market" };
}

export type ChannelBucket = "market" | "other_pos" | "online" | "wholesale";

// The 4-way revenue-by-channel split used by the Stats page's KPI card and
// doughnut chart. Bucketed case-insensitively by substring rather than
// exact string match, since the precise runtime value of Shopify's
// sourceName/"Source" column can't be verified against Lukas's live store
// from here — "online" is the catch-all default so the four buckets always
// exactly partition total revenue even if a new channel value shows up.
export function computeChannelBucket(
  channel: string | null,
  posCategory: "market" | "other" | null,
): ChannelBucket {
  const lower = (channel || "").toLowerCase();
  if (lower.includes("pos")) {
    return posCategory === "market" ? "market" : "other_pos";
  }
  if (lower.includes("draft")) {
    return "wholesale";
  }
  return "online";
}
