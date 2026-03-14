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

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

