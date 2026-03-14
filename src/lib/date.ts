export const msPerDay = 24 * 60 * 60 * 1000;

/** Parse YYYY-MM-DD as local midnight (avoids UTC shift making the date one day off in some timezones). */
export function toMidnight(dateStr: string): Date {
  const datePart = dateStr.slice(0, 10);
  const [y, m, d] = datePart.split(/[-/]/).map(Number);
  if (y == null || m == null || d == null || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    const fallback = new Date(dateStr);
    fallback.setHours(0, 0, 0, 0);
    return fallback;
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Format as local calendar date (avoids UTC date-only strings showing as previous day). */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const datePart = dateStr.slice(0, 10);
  const [y, m, d] = datePart.split(/[-/]/).map(Number);
  if (y != null && m != null && d != null && !Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
    const local = new Date(y, m - 1, d, 0, 0, 0, 0);
    return local.toLocaleDateString();
  }
  const fallback = new Date(dateStr);
  if (Number.isNaN(fallback.getTime())) return "";
  return fallback.toLocaleDateString();
}

