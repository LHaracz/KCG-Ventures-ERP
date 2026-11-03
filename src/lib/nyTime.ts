/** Date/time display in America/New_York, used by the picking/shipping screens. */
export const NY_TIME_ZONE = "America/New_York";

function toDate(v: string | Date | null | undefined): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** e.g. "11/2/2026" */
export function formatNyDate(v: string | Date | null | undefined): string {
  const d = toDate(v);
  return d ? d.toLocaleDateString("en-US", { timeZone: NY_TIME_ZONE }) : "";
}

/** e.g. "8:47 PM" */
export function formatNyTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  return d ? d.toLocaleTimeString("en-US", { timeZone: NY_TIME_ZONE, hour: "numeric", minute: "2-digit" }) : "";
}

/** e.g. "11/2/2026, 8:47 PM" */
export function formatNyDateTime(v: string | Date | null | undefined): string {
  const d = toDate(v);
  return d
    ? d.toLocaleString("en-US", { timeZone: NY_TIME_ZONE, month: "numeric", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}
