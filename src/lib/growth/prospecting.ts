/**
 * Prospecting helpers: Google Maps route links, the funnel and goal progress.
 */
import { diffDays } from "./dates";

/**
 * Waypoints per Google Maps directions link. Google's Maps URLs docs: up to 9
 * waypoints (only 3 when the link opens in a mobile browser instead of the
 * Google Maps app).
 */
export const MAPS_MAX_WAYPOINTS = 9;
const MAPS_DIR = "https://www.google.com/maps/dir/?api=1";

export type StopAddress = { label: string; address: string | null | undefined };
export type RouteLinks = { links: Array<{ label: string; url: string; stops: string[] }>; warnings: string[] };

/** One-line address for Maps ("1 Market Way, Shopton, PA 19100"). Null when there's nothing to route to. */
export function addressLine(a: { address_line1?: string | null; address_line2?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string | null {
  const stateZip = [a.state, a.zip].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
  const parts = [a.address_line1, a.address_line2, a.city].map((x) => (x ?? "").trim()).filter(Boolean);
  if (!a.address_line1?.trim() && !a.city?.trim()) return null;
  return [...parts, stateZip].filter(Boolean).join(", ");
}

export const mapsPlaceUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

/**
 * Directions links in stop order. The origin is left out (the phone starts
 * from where it is); each link ends at its last stop and holds up to
 * MAPS_MAX_WAYPOINTS stops before it. Longer trips are split into parts
 * (open Part 2 when you reach the end of Part 1). Stops without an address
 * are skipped with a warning. No geocoding, no requests.
 */
export function mapsRouteUrls(stops: readonly StopAddress[]): RouteLinks {
  const warnings: string[] = [];
  const addrs: Array<{ label: string; address: string }> = [];
  for (const s of stops) {
    // "|" separates waypoints in the link, so it never appears inside an address.
    const a = (s.address ?? "").replace(/\|/g, " ").trim();
    if (!a) warnings.push(`${s.label} has no address and was left out of the route.`);
    else addrs.push({ label: s.label, address: a });
  }
  const perLink = MAPS_MAX_WAYPOINTS + 1;
  const chunks: Array<typeof addrs> = [];
  for (let i = 0; i < addrs.length; i += perLink) chunks.push(addrs.slice(i, i + perLink));
  const links = chunks.map((chunk, i) => {
    const dest = chunk[chunk.length - 1];
    const waypoints = chunk.slice(0, -1);
    let url = `${MAPS_DIR}&destination=${encodeURIComponent(dest.address)}&travelmode=driving`;
    if (waypoints.length > 0) url += `&waypoints=${waypoints.map((w) => encodeURIComponent(w.address)).join("%7C")}`;
    return { label: chunks.length > 1 ? `Part ${i + 1}` : "Route", url, stops: chunk.map((c) => c.label) };
  });
  return { links, warnings };
}

export const LEAD_STATUSES = ["to_visit", "visited", "samples_left", "follow_up", "negotiating", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  to_visit: "To visit",
  visited: "Visited",
  samples_left: "Samples left",
  follow_up: "Follow up",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
};

export function funnelCounts(leads: ReadonlyArray<{ status: string; archived_at?: string | null }>): Record<LeadStatus, number> {
  const out = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const l of leads) if (!l.archived_at && (LEAD_STATUSES as readonly string[]).includes(l.status)) out[l.status as LeadStatus]++;
  return out;
}

export function goalProgress(input: { won: number; goal: number | null; goalDate: string | null; today: string }) {
  if (!input.goal || input.goal <= 0) return { percent: null, daysRemaining: null, reached: false };
  const percent = Math.min(100, Math.round((input.won / input.goal) * 100));
  return {
    percent,
    daysRemaining: input.goalDate ? diffDays(input.today, input.goalDate) : null,
    reached: input.won >= input.goal,
  };
}

/** A follow-up is due when its date is on or before today and the lead is still open. */
export const followUpDue = (l: { next_follow_up_date: string | null; status: string; archived_at?: string | null }, today: string) =>
  !l.archived_at && !!l.next_follow_up_date && l.next_follow_up_date <= today && l.status !== "won" && l.status !== "lost";
