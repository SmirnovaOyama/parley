import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSchedule, nextOccurrence } from "../server/schedule-time.ts";

function next(value: unknown, after: string): string | null {
  const schedule = cleanSchedule(value);
  assert.ok(schedule, `Expected a valid schedule: ${JSON.stringify(value)}`);
  return nextOccurrence(schedule, Date.parse(after));
}

test("accepts explicit IANA time zones and valid once, daily and weekly schedules", () => {
  const schedules = [
    { kind: "once", timeZone: "Asia/Singapore", date: "2028-02-29", time: "09:05" },
    { kind: "daily", timeZone: "America/New_York", time: "23:59" },
    { kind: "weekly", timeZone: "UTC", time: "00:00", days: [0, 2, 6] },
  ];
  for (const schedule of schedules) assert.deepEqual(cleanSchedule(schedule), schedule);
});

test("rejects malformed schedules instead of normalizing impossible dates or times", () => {
  const daily = { kind: "daily", timeZone: "Asia/Singapore", time: "09:30" };
  const invalid = [
    null, false, [], "daily", {},
    { ...daily, kind: "monthly" },
    { ...daily, timeZone: "Not/A_Time_Zone" },
    { ...daily, timeZone: "" },
    { ...daily, timeZone: 8 },
    { ...daily, time: "24:00" },
    { ...daily, time: "12:60" },
    { ...daily, time: "09:30:00" },
    { ...daily, time: "9:30" },
    { ...daily, time: 930 },
    { ...daily, kind: "once" },
    { ...daily, kind: "once", date: "2026-02-29" },
    { ...daily, kind: "once", date: "2026-04-31" },
    { ...daily, kind: "once", date: "2026-13-01" },
    { ...daily, kind: "once", date: "2026-2-03" },
    { ...daily, kind: "weekly" },
    { ...daily, kind: "weekly", days: [] },
    { ...daily, kind: "weekly", days: [-1] },
    { ...daily, kind: "weekly", days: [7] },
    { ...daily, kind: "weekly", days: [1.5] },
    { ...daily, kind: "weekly", days: ["1"] },
  ];
  for (const value of invalid) assert.equal(cleanSchedule(value), null, JSON.stringify(value));
});

test("returns UTC instants strictly after the boundary for a Singapore daily schedule", () => {
  const schedule = { kind: "daily", timeZone: "Asia/Singapore", time: "09:00" };
  assert.equal(next(schedule, "2026-10-14T00:59:59.999Z"), "2026-10-14T01:00:00.000Z");
  assert.equal(next(schedule, "2026-10-14T01:00:00.000Z"), "2026-10-15T01:00:00.000Z");
  assert.equal(next(schedule, "2026-10-14T01:00:00.001Z"), "2026-10-15T01:00:00.000Z");
});

test("a one-off schedule is exhausted at its single occurrence", () => {
  const schedule = { kind: "once", timeZone: "Asia/Singapore", date: "2026-10-15", time: "09:00" };
  assert.equal(next(schedule, "2026-10-14T00:00:00.000Z"), "2026-10-15T01:00:00.000Z");
  assert.equal(next(schedule, "2026-10-15T01:00:00.000Z"), null);
  assert.equal(next(schedule, "2026-10-16T00:00:00.000Z"), null);
});

test("weekly days refer to the chosen local time zone, including Sunday as zero", () => {
  const weekdays = { kind: "weekly", timeZone: "Asia/Singapore", time: "09:00", days: [1, 5] };
  assert.equal(next(weekdays, "2026-10-14T00:00:00.000Z"), "2026-10-16T01:00:00.000Z");
  assert.equal(next(weekdays, "2026-10-16T01:00:00.000Z"), "2026-10-19T01:00:00.000Z");
  const sunday = { kind: "weekly", timeZone: "Asia/Singapore", time: "00:30", days: [0] };
  assert.equal(next(sunday, "2026-10-17T16:00:00.000Z"), "2026-10-17T16:30:00.000Z");
});

test("New York spring DST skips a missing local time instead of shifting it", () => {
  const daily = { kind: "daily", timeZone: "America/New_York", time: "02:30" };
  assert.equal(next(daily, "2026-03-07T08:00:00.000Z"), "2026-03-09T06:30:00.000Z");
  const weekly = { ...daily, kind: "weekly", days: [0] };
  assert.equal(next(weekly, "2026-03-01T08:00:00.000Z"), "2026-03-15T06:30:00.000Z");
  const once = { ...daily, kind: "once", date: "2026-03-08" };
  assert.equal(next(once, "2026-03-07T00:00:00.000Z"), null);
});

test("New York autumn DST chooses the first occurrence and never runs twice that local day", () => {
  const daily = { kind: "daily", timeZone: "America/New_York", time: "01:30" };
  assert.equal(next(daily, "2026-11-01T05:00:00.000Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next(daily, "2026-11-01T05:30:00.000Z"), "2026-11-02T06:30:00.000Z");
  assert.equal(next(daily, "2026-11-01T05:45:00.000Z"), "2026-11-02T06:30:00.000Z");
  const once = { ...daily, kind: "once", date: "2026-11-01" };
  assert.equal(next(once, "2026-11-01T05:00:00.000Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next(once, "2026-11-01T05:45:00.000Z"), null);
  const weekly = { ...daily, kind: "weekly", days: [0] };
  assert.equal(next(weekly, "2026-11-01T05:45:00.000Z"), "2026-11-08T06:30:00.000Z");
});

test("schedules preserve local wall-clock time when New York's UTC offset changes", () => {
  const schedule = { kind: "daily", timeZone: "America/New_York", time: "09:00" };
  assert.equal(next(schedule, "2026-03-07T13:59:00.000Z"), "2026-03-07T14:00:00.000Z");
  assert.equal(next(schedule, "2026-03-07T14:00:00.000Z"), "2026-03-08T13:00:00.000Z");
  assert.equal(next(schedule, "2026-10-31T13:00:00.000Z"), "2026-11-01T14:00:00.000Z");
});
