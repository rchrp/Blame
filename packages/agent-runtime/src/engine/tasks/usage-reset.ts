// When a used-up plan resets. The engine knows it when the provider gives a
// delay (ChatGPT's `resets_in_seconds`); Claude Code only writes it in its
// message ("You've hit your session limit · resets 1:10am (Europe/Bucharest)").
// A task's failure keeps it as an instant, so a message read later (a saved
// analysis) still says when, and the app can wait for it.

import type { ErrorInfo } from "@blame/engine-client";

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The instant the plan resets, when the provider said it. */
export function usageResetAt(error: ErrorInfo, now = Date.now()): Date | undefined {
  if (typeof error.retry_after_ms === "number" && error.retry_after_ms > 0)
    return new Date(now + error.retry_after_ms);
  return statedReset(error.message, now);
}

/**
 * "resets 1:10am (Europe/Bucharest)", "reset at 3pm (America/New_York)",
 * "resets Nov 24, 9am (Europe/Paris)": the next such wall-clock time in that
 * zone (this computer's zone when none is given).
 */
export function statedReset(text: string, now = Date.now()): Date | undefined {
  const match =
    /\breset(?:s| at|s at)?\s+(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/iu.exec(
      text,
    );
  if (!match) return undefined;
  const [, monthName, day, hourText, minuteText, meridiem, zone] = match;
  const hour = (Number(hourText) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(minuteText ?? 0);
  if (hour > 23 || minute > 59) return undefined;
  const timeZone = zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = wallClock(now, timeZone);
  if (!today) return undefined;
  const month = monthName ? months.indexOf(monthName.toLowerCase()) : -1;
  if (monthName && month < 0) return undefined;
  // A stated date is this year's or next year's; a time alone is today's or tomorrow's.
  const days =
    month >= 0
      ? [0, 1].map((years) => Date.UTC(today.year + years, month, Number(day)))
      : [0, 1].map((days) => Date.UTC(today.year, today.month, today.day + days));
  for (const midnight of days) {
    const date = new Date(midnight);
    const instant = zonedInstant(
      { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), hour, minute },
      timeZone,
    );
    if (instant !== undefined && instant > now) return new Date(instant);
  }
  return undefined;
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

function wallClock(at: number, timeZone: string): WallClock | undefined {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      })
        .formatToParts(at)
        .map((part) => [part.type, Number(part.value)]),
    );
    return {
      year: parts.year!,
      month: parts.month! - 1,
      day: parts.day!,
      hour: parts.hour!,
      minute: parts.minute!,
    };
  } catch {
    return undefined; // not a zone this computer knows
  }
}

/** The UTC instant of a wall-clock time in a zone (offset found by asking the zone twice). */
function zonedInstant(clock: WallClock, timeZone: string): number | undefined {
  const asUtc = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute);
  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(guess, timeZone);
    if (!seen) return undefined;
    const seenUtc = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    guess += asUtc - seenUtc;
  }
  return guess;
}
