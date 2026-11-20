import { toEpoch } from "../shared/time.js";

/** Reject overflow dates (for example April 31) instead of letting Date roll into the next month. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day > 0 && day <= (days[month - 1] ?? 0);
}

/** Query input also permits Z and minute precision; tender output applies the frozen schema first. */
export function dateTimeEpoch(value: string): number {
  const clock = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  return clock.test(value) && isCalendarDate(value.slice(0, 10)) ? toEpoch(value) : NaN;
}