/**
 * Date-only helpers for "YYYY-MM-DD" values. Whole calendar days in UTC, so
 * daylight saving changes never move a date. "Today" is New York's date.
 */
import { addDays, isIsoDate } from "@/lib/retail/dueDate";
import { todayNy } from "@/lib/retail/format";

export { addDays, isIsoDate, todayNy };

const utc = (iso: string) => {
  if (!isIsoDate(iso)) throw new Error(`Not a date: ${iso}`);
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export const maxDate = (dates: ReadonlyArray<string | null | undefined>): string | null =>
  dates.reduce<string | null>((m, d) => (d && (!m || d > m) ? d : m), null);

/** New York date of a timestamp (e.g. a Receiving Log entry's performed_at). */
export function nyDateOf(timestamp: string | Date): string {
  return todayNy(typeof timestamp === "string" ? new Date(timestamp) : timestamp);
}
