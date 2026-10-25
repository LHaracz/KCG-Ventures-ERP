/**
 * Overdue computation for scheduled log types, shared by the Logs hub, the
 * per-type entries page, and the release-warnings panel (so "overdue" means
 * exactly the same thing in all three places).
 *
 * Judgment call, documented here rather than left implicit: "overdue" is
 * evaluated per fully-elapsed period, not the still-open current one — a
 * daily log due today isn't flagged overdue until today ends with nothing
 * logged; a weekly log isn't flagged until the week ends empty. This
 * matches the spec's "no entry exists in the current period after that
 * period's due time has passed" read literally (the period's due time =
 * its end). The lookback is capped (LOOKBACK_DAYS below) so a log type
 * that's existed for months doesn't surface years of ancient gaps, and
 * never looks earlier than the log type's own created_at.
 */

import type { LogEntry, LogType, WeekdayKey } from "./complianceLogs";
import { WEEKDAY_KEYS } from "./complianceLogs";

const LOOKBACK_DAYS = 60;

export type MissedPeriod = { label: string; periodStart: Date; periodEnd: Date };

export type OverdueResult = {
  isOverdue: boolean;
  lastEntryAt: string | null;
  missedPeriods: MissedPeriod[]; // most recent first
};

export function weekdayKeyOf(date: Date): WeekdayKey {
  // getUTCDay(): 0=Sun..6=Sat. We treat all period math in UTC calendar days
  // for determinism (the app has no stored business timezone to anchor to).
  const idx = date.getUTCDay();
  return WEEKDAY_KEYS[(idx + 6) % 7]; // shift so Monday(getUTCDay=1) -> "mon"
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function startOfUtcWeek(date: Date): Date {
  const day = startOfUtcDay(date);
  const weekday = day.getUTCDay(); // 0=Sun
  const diffToMonday = (weekday + 6) % 7;
  day.setUTCDate(day.getUTCDate() - diffToMonday);
  return day;
}

export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function entryTimestamps(entries: LogEntry[]): number[] {
  return entries
    .map((e) => new Date(e.performed_at).getTime())
    .filter((t) => Number.isFinite(t));
}

function mostRecentEntryAt(entries: LogEntry[]): string | null {
  if (entries.length === 0) return null;
  const latest = entries.reduce((max, e) => (e.performed_at > max ? e.performed_at : max), entries[0].performed_at);
  return latest;
}

export function hasEntryInRange(timestamps: number[], start: Date, end: Date): boolean {
  const s = start.getTime();
  const e = end.getTime();
  return timestamps.some((t) => t >= s && t < e);
}

/** Daily/weekly/monthly only — per_cycle is handled by computePerCycleOverdue below. */
export function computeScheduledOverdue(logType: LogType, entries: LogEntry[], now: Date = new Date()): OverdueResult {
  const lastEntryAt = mostRecentEntryAt(entries);
  if (logType.schedule_type === "none" || logType.schedule_type === "per_cycle") {
    return { isOverdue: false, lastEntryAt, missedPeriods: [] };
  }

  const timestamps = entryTimestamps(entries);
  const createdAt = new Date(logType.created_at);
  const lookbackFloor = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const earliestConsidered = createdAt > lookbackFloor ? createdAt : lookbackFloor;

  const missed: MissedPeriod[] = [];

  if (logType.schedule_type === "daily") {
    const todayStart = startOfUtcDay(now);
    // Walk backwards one day at a time from "yesterday" (today's own period
    // hasn't ended yet) until we pass earliestConsidered.
    for (
      let dayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
      dayStart.getTime() >= earliestConsidered.getTime();
      dayStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000)
    ) {
      if (!logType.schedule_days.includes(weekdayKeyOf(dayStart))) continue;
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
      if (!hasEntryInRange(timestamps, dayStart, dayEnd)) {
        missed.push({
          label: dayStart.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
          periodStart: dayStart,
          periodEnd: dayEnd,
        });
      }
    }
  } else if (logType.schedule_type === "weekly") {
    const thisWeekStart = startOfUtcWeek(now);
    for (
      let weekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
      weekStart.getTime() >= earliestConsidered.getTime();
      weekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000)
    ) {
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (!hasEntryInRange(timestamps, weekStart, weekEnd)) {
        missed.push({
          label: `Week of ${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
          periodStart: weekStart,
          periodEnd: weekEnd,
        });
      }
    }
  } else if (logType.schedule_type === "monthly") {
    const thisMonthStart = startOfUtcMonth(now);
    let monthStart = new Date(thisMonthStart);
    monthStart.setUTCMonth(monthStart.getUTCMonth() - 1);
    while (monthStart.getTime() >= earliestConsidered.getTime()) {
      const monthEnd = new Date(monthStart);
      monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
      if (!hasEntryInRange(timestamps, monthStart, monthEnd)) {
        missed.push({
          label: monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
          periodStart: monthStart,
          periodEnd: monthEnd,
        });
      }
      const prev = new Date(monthStart);
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      monthStart = prev;
    }
  }

  return { isOverdue: missed.length > 0, lastEntryAt, missedPeriods: missed };
}

export type CycleForOverdue = {
  id: string;
  status: "draft" | "planned" | "completed";
  completed_at: string | null;
  start_date: string | null;
  businessType: "BotanIQals" | "MiniLeaf";
};

// "Just completed" is a judgment call the spec leaves open — a BotanIQals
// cycle stays relevant to per_cycle checks for this long after completion,
// so a record can still be caught/backfilled shortly after Complete
// Production without every historical cycle counting forever.
const JUST_COMPLETED_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export function isCycleRelevantForPerCycleCheck(cycle: CycleForOverdue, now: Date = new Date()): boolean {
  if (cycle.businessType !== "BotanIQals") return false;
  if (cycle.status !== "completed") return true; // draft/planned = "in progress" in this app's model
  if (!cycle.completed_at) return false;
  return now.getTime() - new Date(cycle.completed_at).getTime() <= JUST_COMPLETED_WINDOW_MS;
}

export type PerCycleOverdueResult = {
  isOverdue: boolean;
  missingForCycles: Array<{ cycleId: string; label: string }>;
};

export function computePerCycleOverdue(
  relevantCycles: Array<CycleForOverdue & { label: string }>,
  entries: LogEntry[],
): PerCycleOverdueResult {
  const linkedCycleIds = new Set(entries.map((e) => e.production_cycle_id).filter(Boolean) as string[]);
  const missingForCycles = relevantCycles
    .filter((c) => !linkedCycleIds.has(c.id))
    .map((c) => ({ cycleId: c.id, label: c.label }));
  return { isOverdue: missingForCycles.length > 0, missingForCycles };
}

export type CycleWindowCoverageResult = {
  isCovered: boolean;
  missingDates: string[]; // daily only — each missing scheduled day, oldest first
};

/**
 * Release-warnings check #1 for daily/weekly/monthly types (per_cycle is
 * computePerCycleOverdue above): "daily types need an entry for each
 * scheduled day from the cycle's start date through today; weekly/monthly
 * types need an entry in the current period." Deliberately distinct from
 * computeScheduledOverdue — that one only flags a FULLY ELAPSED period
 * (so it never flags today), while a release check scoped to one cycle
 * needs to know about today's coverage too.
 */
export function computeCycleWindowCoverage(
  logType: Pick<LogType, "schedule_type" | "schedule_days">,
  entries: LogEntry[],
  cycleStartDate: string | null,
  now: Date = new Date(),
): CycleWindowCoverageResult {
  if (logType.schedule_type === "none" || logType.schedule_type === "per_cycle") {
    return { isCovered: true, missingDates: [] };
  }

  const timestamps = entryTimestamps(entries);

  if (logType.schedule_type === "weekly") {
    const covered = hasEntryInRange(timestamps, startOfUtcWeek(now), new Date(now.getTime() + 1));
    return { isCovered: covered, missingDates: [] };
  }
  if (logType.schedule_type === "monthly") {
    const covered = hasEntryInRange(timestamps, startOfUtcMonth(now), new Date(now.getTime() + 1));
    return { isCovered: covered, missingDates: [] };
  }

  // daily — capped at the same LOOKBACK_DAYS floor as computeScheduledOverdue,
  // so a cycle that has sat in draft/planned for a long time doesn't walk
  // back indefinitely.
  const todayStart = startOfUtcDay(now);
  const lookbackFloor = startOfUtcDay(new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  const rawCycleStart = cycleStartDate ? startOfUtcDay(new Date(cycleStartDate)) : todayStart;
  const cycleStart = rawCycleStart.getTime() < lookbackFloor.getTime() ? lookbackFloor : rawCycleStart;
  const missingDates: string[] = [];
  for (
    let dayStart = cycleStart.getTime() <= todayStart.getTime() ? cycleStart : todayStart;
    dayStart.getTime() <= todayStart.getTime();
    dayStart = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  ) {
    if (!logType.schedule_days.includes(weekdayKeyOf(dayStart))) continue;
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    if (!hasEntryInRange(timestamps, dayStart, dayEnd)) {
      missingDates.push(dayStart.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    }
  }
  return { isCovered: missingDates.length === 0, missingDates };
}
