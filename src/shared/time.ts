/**
 * Time helpers. The brief requires every time as date and time WITH offset,
 * e.g. 2026-12-09T10:00:00+01:00. Use these everywhere; never toISOString() in API output.
 */

const SERVER_TZ = process.env.TZ_DISPLAY ?? "Europe/Berlin";

/** Offset in minutes of `zone` at instant `date` (e.g. +60 for Europe/Berlin in winter). */
export function offsetMinutes(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, "0");
}

/** Formats an instant in `zone` as 2026-12-09T10:00:00+01:00. */
export function formatWithOffset(date: Date, zone: string = SERVER_TZ): string {
  const off = offsetMinutes(date, zone);
  const local = new Date(date.getTime() + off * 60000);
  const sign = off >= 0 ? "+" : "-";
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** Current time with offset. */
export function nowWithOffset(): string {
  return formatWithOffset(new Date());
}

/**
 * Interprets a wall-clock time shown on a portal (no offset) in the portal's zone.
 * localWallTime("2026-12-09", "10:00", "Europe/Berlin") -> "2026-12-09T10:00:00+01:00"
 * Handles DST by re-checking the offset at the resulting instant.
 */
export function localWallTime(date: string, time: string, zone: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(":").map(Number) as [number, number, number?];
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let instant = guess - offsetMinutes(new Date(guess), zone) * 60000;
  instant = guess - offsetMinutes(new Date(instant), zone) * 60000;
  return formatWithOffset(new Date(instant), zone);
}

/** Parses any date-time-with-offset string to epoch ms. */
export function toEpoch(s: string): number {
  return new Date(s).getTime();
}
