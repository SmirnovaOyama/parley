// Wall-clock schedules keep their local hour when a timezone changes its UTC offset.
export type TaskSchedule = {
  kind: "once" | "daily" | "weekly";
  timeZone: string;
  time: string;
  date?: string;
  days?: number[];
};

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function wall(ms: number, timeZone: string): number[] {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number);
}

function dateParts(value: unknown): number[] | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1970 || year > 9998) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day ? [year, month, day] : null;
}

export function cleanSchedule(input: unknown): TaskSchedule | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<TaskSchedule>;
  if (!["once", "daily", "weekly"].includes(value.kind ?? "") || typeof value.timeZone !== "string" || value.timeZone.length > 100 ||
      typeof value.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return null;
  let timeZone: string;
  try { timeZone = formatter(value.timeZone).resolvedOptions().timeZone; } catch { return null; }
  const result: TaskSchedule = { kind: value.kind!, timeZone, time: value.time };
  if (value.kind === "once") {
    if (!dateParts(value.date)) return null;
    result.date = value.date;
  } else if (value.kind === "weekly") {
    if (!Array.isArray(value.days) || !value.days.length || value.days.length > 7 || value.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
    result.days = [...new Set(value.days)].sort((a, b) => a - b);
  }
  return result;
}

/** A missing spring-forward time is skipped; a repeated autumn time uses its first occurrence. */
function instant(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number | null {
  const nominal = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  // Sample both sides of even large timezone shifts, then verify each candidate's local fields.
  for (let h = -36; h <= 36; h += 12) {
    const sample = nominal + h * 3_600_000;
    const [y, m, d, hh, mm, ss] = wall(sample, timeZone);
    offsets.add(Date.UTC(y, m - 1, d, hh, mm, ss) - sample);
  }
  const matches = [...offsets].map((offset) => nominal - offset).filter((ms) => {
    const [y, m, d, hh, mm] = wall(ms, timeZone);
    return y === year && m === month && d === day && hh === hour && mm === minute;
  });
  return matches.length ? Math.min(...matches) : null;
}

/** First occurrence strictly after `afterMs`, or null when a one-time schedule has ended. */
export function nextOccurrence(schedule: TaskSchedule, afterMs: number): string | null {
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (schedule.kind === "once") {
    const [year, month, day] = dateParts(schedule.date)!;
    const at = instant(year, month, day, hour, minute, schedule.timeZone);
    return at !== null && at > afterMs ? new Date(at).toISOString() : null;
  }
  const [year, month, day] = wall(afterMs, schedule.timeZone);
  const localDay = Date.UTC(year, month - 1, day);
  for (let offset = 0; offset < 370; offset++) {
    const date = new Date(localDay + offset * DAY);
    if (schedule.kind === "weekly" && !schedule.days!.includes(date.getUTCDay())) continue;
    const at = instant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, schedule.timeZone);
    if (at !== null && at > afterMs) return new Date(at).toISOString();
  }
  return null;
}
